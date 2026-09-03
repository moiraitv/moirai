import { describe, expect, it, vi } from 'vitest';
import { MAX_MEDIA_SCAN_ATTEMPTS, runScanQueue } from '@server/scanner/scan-queue.js';

describe('bounded scan queue', () => {
	it('waits for in-flight first attempts and retries the correct file within the concurrency limit', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const calls: string[] = [];
		let active = 0;
		let maximumActive = 0;
		const running = runScanQueue(['held', 'retry', 'healthy'], {
			concurrency: 2,
			processFile: async (file) => {
				calls.push(file);
				active += 1;
				maximumActive = Math.max(active, maximumActive);
				try {
					if (file === 'held') {
						await held;
					}
					return file === 'retry' && calls.filter((called) => called === file).length === 1
						? 'retry' : 'complete';
				}
				finally {
					active -= 1;
				}
			},
		});
		try {
			await vi.waitFor(() => expect(calls).toEqual(['held', 'retry', 'healthy']));
		}
		finally {
			release();
			await running;
		}
		expect(calls).toEqual(['held', 'retry', 'healthy', 'retry']);
		expect(maximumActive).toBe(2);
	});

	it('bounds attempts and advances progress only when files settle', async () => {
		const onProgress = vi.fn();
		const processFile = vi.fn(async (_file: string, canRetry: boolean) => canRetry ? 'retry' as const : 'complete' as const);
		await runScanQueue(['first', 'second'], { concurrency: 2, processFile, onProgress });

		expect(processFile).toHaveBeenCalledTimes(2 * MAX_MEDIA_SCAN_ATTEMPTS);
		expect(processFile.mock.calls.filter(([, canRetry]) => !canRetry)).toHaveLength(2);
		expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
			{ phase: 'processing', processedCount: 1, totalCount: 2 },
			{ phase: 'processing', processedCount: 2, totalCount: 2 },
		]);
	});
});
