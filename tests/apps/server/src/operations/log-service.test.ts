import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LogService } from '@server/operations/log-service.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 2_000;
	let value = await read();
	while (!ready(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		value = await read();
	}
	return value;
}

describe('on-disk logs', () => {
	it('writes searchable structured entries and redacts secrets', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-logs-'));
		const logs = new LogService(root, 'info', 1024 * 1024, 14, 10 * 1024 * 1024);
		cleanups.push(async () => {
			await logs.close();
			await rm(root, { recursive: true, force: true });
		});
		logs.logger.info(
			{ requestId: 'req-1', token: 'do-not-store', category: 'scanner' },
			'Catalog scan completed',
		);
		const files = await eventually(() => logs.files(), (value) => value.length === 1);
		expect(files[0]?.active).toBe(true);
		const page = await eventually(
			() => logs.page({ search: 'catalog', level: 'info', limit: 20 }),
			(value) => value.entries.length === 1,
		);
		expect(page.entries[0]).toMatchObject({
			message: 'Catalog scan completed',
			requestId: 'req-1',
			context: { token: '[Redacted]', category: 'scanner' },
		});
	});

	it('rejects forged cursors and file traversal', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-logs-'));
		const logs = new LogService(root, 'silent', 1024, 14, 4096);
		cleanups.push(async () => {
			await logs.close();
			await rm(root, { recursive: true, force: true });
		});
		await expect(logs.page({ cursor: 'not-a-cursor', limit: 20 })).rejects.toThrow(
			'Invalid log cursor',
		);
		await expect(logs.download('../moirai.sqlite')).resolves.toBeNull();
	});
});
