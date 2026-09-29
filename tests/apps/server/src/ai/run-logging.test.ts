import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AiRunLogger } from '@server/ai/run-logging.js';
import { AiTimeoutError } from '@server/ai/errors.js';
import { LogService } from '@server/operations/log-service.js';

it('writes searchable AI lifecycle entries with safe outcome and usage details', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'moirai-ai-log-'));
	const logs = new LogService(directory, 'info', 1024 * 1024, 14, 10 * 1024 * 1024);
	try {
		const ai = { apiKey: 'private-api-key', baseUrl: 'https://example.test/v1', model: 'test-model',
			providerId: 'openrouter' as const, webSearch: true };
		const run = new AiRunLogger(logs.logger, ai, 'library-id', 200, 'generation-id');
		run.start();
		run.progress('discovering');
		run.progress('discovering');
		run.progress('searching', { batch: 1, totalBatches: 2 });
		run.setMetrics({ requests: 3, requestUsage: [], requestDiagnostics: [], searchBudgetOverrun: false,
			toolCalls: 2, inputTokens: 120, outputTokens: 40, usageReported: true, durationMs: 100 });
		run.complete({ itemIds: ['selected-id'], unmatched: [], catalogTruncated: false,
			coverage: { libraryCount: 10, reviewedCount: 8, shortlistLimited: true,
				embeddingsAvailable: true, searchBudgetExhausted: false } });
		const failed = new AiRunLogger(logs.logger, ai, 'library-id', 200, 'failed-id');
		failed.start();
		failed.progress('reviewing');
		failed.fail(new AiTimeoutError('private provider text'));
		const cancelled = new AiRunLogger(logs.logger, ai, 'library-id', 200, 'cancelled-id');
		cancelled.start();
		cancelled.cancel();
		await logs.close();

		const entries = (await logs.page({ search: 'AI generation', limit: 20 })).entries;
		expect(entries.map(entry => entry.message)).toEqual([
			'AI generation cancelled', 'AI generation started', 'AI generation failed',
			'AI generation progress', 'AI generation started', 'AI generation completed',
			'AI generation progress', 'AI generation progress', 'AI generation started',
		]);
		expect(entries.find(entry => entry.message === 'AI generation completed')?.context).toMatchObject({
			aiGeneration: { id: 'generation-id', provider: 'openrouter', webResearch: true,
				selectedCount: 1, reviewedCount: 8, metrics: { toolCalls: 2, inputTokens: 120 } },
		});
		expect(entries.find(entry => entry.message === 'AI generation failed')?.context).toMatchObject({
			aiGeneration: { id: 'failed-id', phase: 'reviewing', failureCategory: 'timeout' },
		});
		expect(JSON.stringify(entries)).not.toContain('private-api-key');
		expect(JSON.stringify(entries)).not.toContain('private provider text');
	}
	finally {
		await logs.close();
		await rm(directory, { recursive: true, force: true });
	}
});
