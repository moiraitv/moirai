import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlaybackEngine } from '@server/playback/playback-engine.js';
import { LogService } from '@server/operations/log-service.js';
import { describe, expect, it } from 'vitest';
import { WorkerLogLines, PLAYBACK_LOG_LINE_LIMIT } from '@server/playback/worker-log-lines.js';

describe('playback worker diagnostics', () => {
	it('redacts signed capabilities at every possible chunk boundary', () => {
		const input = Buffer.from('ffmpeg -i "http://127.0.0.1/media?sig=synthetic-capability&other=value"\n');
		for (let split = 0; split <= input.length; split += 1) {
			const messages: string[] = [];
			const lines = new WorkerLogLines((message) => messages.push(message));
			lines.write(input.subarray(0, split));
			lines.write(input.subarray(split));
			lines.finish();
			expect(messages).toEqual(['ffmpeg -i "http://127.0.0.1/media?sig=[Redacted]&other=value"']);
		}
	});

	it('redacts graphics clock capabilities at every possible chunk boundary', () => {
		const input = Buffer.from('Input http://127.0.0.1:32100/clock/synthetic-clock-token\n');
		for (let split = 0; split <= input.length; split += 1) {
			const messages: string[] = [];
			const lines = new WorkerLogLines((message) => messages.push(message));
			lines.write(input.subarray(0, split));
			lines.write(input.subarray(split));
			lines.finish();
			expect(messages).toEqual(['Input http://127.0.0.1:32100/clock/[redacted]']);
		}
	});

	it('flushes an unterminated UTF-8 line without exposing its signature', () => {
		const messages: string[] = [];
		const lines = new WorkerLogLines((message) => messages.push(message));
		for (const byte of Buffer.from('Film 🎬 http://localhost/media?sig=synthetic-capability')) {
			lines.write(Buffer.from([byte]));
		}
		expect(messages).toEqual([]);
		lines.finish();
		lines.finish();
		expect(messages).toEqual(['Film 🎬 http://localhost/media?sig=[Redacted]']);
	});

	it('bounds oversized lines and redacts a signature cut off at the retained boundary', () => {
		const messages: string[] = [];
		const lines = new WorkerLogLines((message) => messages.push(message));
		const prefix = 'x'.repeat(PLAYBACK_LOG_LINE_LIMIT - 10);
		lines.write(Buffer.from(`${prefix}?sig=synthetic-capability${'x'.repeat(PLAYBACK_LOG_LINE_LIMIT)}\nNext line\n`));
		lines.finish();
		expect(messages).toEqual([`${prefix}?sig=[Redacted] [truncated]`, 'Next line']);
	});
	it('keeps split stdout and stderr signatures out of persisted playback logs', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-worker-logs-'));
		const logs = new LogService(root, 'info', 1_048_576, 1, 1_048_576);
		const child = { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter() };
		const session = { child, channel: { id: 'audit', number: 1 } };
		const diagnostics: string[] = [];
		const owner = { logger: logs.logger, observeWorkerDiagnostics: (_session: unknown, message: string) => diagnostics.push(message) };
		const engine = PlaybackEngine.prototype as unknown as { logChildOutput(this: typeof owner, input: typeof session): void };
		try {
			engine.logChildOutput.call(owner, session);
			child.stdout.emit('data', Buffer.from('Input http://localhost/media?si'));
			child.stderr.emit('data', Buffer.from('Failure http://localhost/media?sig=synthetic-stderr'));
			child.stdout.emit('data', Buffer.from('g=synthetic-stdout\n'));
			child.stderr.emit('end');
			child.stdout.emit('end');
			await logs.close();
			const stored = await logs.page({ limit: 20 });
			expect(stored.entries).toHaveLength(2);
			expect(JSON.stringify(stored)).not.toMatch(/synthetic-(stdout|stderr)/);
			expect(stored.entries.every((entry) => entry.message.includes('sig=[Redacted]'))).toBe(true);
			expect(diagnostics).toEqual(['Failure http://localhost/media?sig=[Redacted]\n']);
		}
		finally {
			await logs.close();
			await rm(root, { recursive: true, force: true });
		}
	});

});
