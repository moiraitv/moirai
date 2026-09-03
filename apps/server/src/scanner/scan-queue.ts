import type { ScanProgress } from '@moirai/shared';

/** Maximum attempts for one physical media file during a single scan, including its first try. */
export const MAX_MEDIA_SCAN_ATTEMPTS = 3;

/** A completed file, or a deferred probe that has not emitted its final item or diagnostics yet. */
export type ScanFileOutcome = 'complete' | 'retry';

/** Bounded discovery work and progress callbacks shared by every scan queue pass. */
interface ScanQueueOptions {
	concurrency: number;
	signal?: AbortSignal | undefined;
	onProgress?: ((progress: ScanProgress) => void) | undefined;
	processFile: (file: string, canRetry: boolean) => Promise<ScanFileOutcome>;
}

/**
 * Process every file before draining deferred probes with the same concurrency limit. Each pass
 * waits for all its in-flight work, so retries never compete with unfinished first attempts. Only
 * terminal outcomes advance file progress; the last pass must finalize every remaining file.
 */
export async function runScanQueue(files: string[], options: ScanQueueOptions): Promise<void> {
	let pending = files;
	let processedFiles = 0;
	for (let attempt = 1; attempt <= MAX_MEDIA_SCAN_ATTEMPTS && pending.length > 0; attempt += 1) {
		const retries: string[] = [];
		let nextFile = 0;
		const canRetry = attempt < MAX_MEDIA_SCAN_ATTEMPTS;

		/** Claim each file once and defer retryable outcomes to the next queue pass. */
		async function processNext(): Promise<void> {
			while (nextFile < pending.length) {
				options.signal?.throwIfAborted();
				const file = pending[nextFile++]!;
				const outcome = await options.processFile(file, canRetry);
				options.signal?.throwIfAborted();
				if (outcome === 'retry') {
					if (!canRetry) {
						throw new Error('A media scan retry exceeded its attempt limit');
					}
					retries.push(file);
					continue;
				}

				processedFiles += 1;
				options.onProgress?.({
					phase: 'processing',
					processedCount: processedFiles,
					totalCount: files.length,
				});
			}
		}

		const concurrency = Math.max(1, Math.min(options.concurrency, pending.length));
		await Promise.all(Array.from({ length: concurrency }, () => processNext()));
		pending = retries;
	}
}
