import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { LiveEventInput } from '@moirai/shared';
import { EmbeddingService, MEDIA_EMBEDDING_BATCH_SIZE } from '@server/semantic/service.js';
import { PREFERENCE_BATCH_SIZE } from '@server/repository/semantic-preferences.js';
import { fixture } from './fixtures.js';

afterEach(() => {
	vi.useRealTimers();
});

it('backfills pending identities asynchronously and reports a missing local model without failing startup', async () => {
	const f = await fixture();
	const events: LiveEventInput[] = [];
	const service = new EmbeddingService(f.semantic, { publish: (event) => events.push(event) }, path.join(f.root, 'missing-model'));
	try {
		vi.useFakeTimers();
		service.start();
		expect(events).toEqual([]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(events).toContainEqual({ type: 'embeddings.changed', data: { pending: f.ids.length, failed: 0, status: 'model-missing' } });
		expect(f.semantic.catalog().preparationError).toContain('matching model is missing');
		await service.suspend();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(events).toHaveLength(1);
		service.resume();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(events).toHaveLength(2);
	}
	finally {
		await service.close();
		vi.useRealTimers();
		await f.close();
	}
});

it.skipIf(process.env.MOIRAI_EMBEDDING_INTEGRATION !== '1')('backfills an existing indexed library through the real asynchronous service and reuses its cache', async () => {
	const f = await fixture();
	const events: LiveEventInput[] = [];
	const service = new EmbeddingService(f.semantic, { publish: (event) => events.push(event) }, path.resolve('apps/server/dist/embedding-model'));
	try {
		await f.repository.updateProgram(f.program.id, { config: { ...f.program.config, type: 'similarity', sourceProgramId: f.source.id, quantity: 3, variety: 35, hardExclusions: ['superhero movies'] } });
		f.semantic.preferences.catalog(['Slow, thoughtful science fiction']);
		service.start();
		await vi.waitFor(() => expect(Object.keys(f.semantic.catalog().vectors)).toHaveLength(f.ids.length), { timeout: 30_000, interval: 250 });
		expect(events.at(-1)).toEqual({ type: 'embeddings.changed', data: { pending: 0, failed: 0, status: 'idle' } });
		expect(f.semantic.reconcile()).toEqual([]);
		expect(f.semantic.preferences.catalog(['superhero movies'])['superhero movies']?.vector).toHaveLength(384);
		expect(f.semantic.preferences.catalog(['Slow, thoughtful science fiction'])['Slow, thoughtful science fiction']?.vector).toHaveLength(384);
		await service.close();
		f.reopen();
		expect(Object.keys(f.semantic.catalog().vectors)).toHaveLength(f.ids.length);
	}
	finally {
		await service.close();
		await f.close();
	}
}, 40_000);

it.skipIf(process.env.MOIRAI_EMBEDDING_INTEGRATION !== '1')('alternates new refinement batches with unfinished library backfill', async () => {
	const f = await fixture(MEDIA_EMBEDDING_BATCH_SIZE * 3 + 1);
	const texts = Array.from({ length: PREFERENCE_BATCH_SIZE + 1 }, (_, index) => `science fiction concept ${index}`);
	const progress: Array<{ media: number; preferences: number }> = [];
	let requested = false;
	const service = new EmbeddingService(f.semantic, { publish: () => {
		const media = Object.keys(f.semantic.catalog().vectors).length;
		if (!requested && media >= MEDIA_EMBEDDING_BATCH_SIZE) {
			requested = true;
			f.semantic.preferences.catalog(texts);
			service.requestPreferences();
		}
		if (requested) {
			const preferences = Object.values(f.semantic.preferences.catalog(texts)).filter((entry) => entry.status === 'ready').length;
			progress.push({ media, preferences });
		}
	} }, path.resolve('apps/server/dist/embedding-model'));
	try {
		service.start();
		await vi.waitFor(() => expect(progress.at(-1)).toEqual({ media: f.ids.length, preferences: texts.length }), { timeout: 20_000, interval: 100 });
		expect(progress.find((entry) => entry.preferences === PREFERENCE_BATCH_SIZE)).toEqual({ media: MEDIA_EMBEDDING_BATCH_SIZE, preferences: PREFERENCE_BATCH_SIZE });
		expect(progress.find((entry) => entry.preferences === texts.length)).toEqual({ media: MEDIA_EMBEDDING_BATCH_SIZE * 2, preferences: texts.length });
		expect(f.semantic.reconcile()).toEqual([]);
	}
	finally {
		await service.close();
		await f.close();
	}
}, 30_000);

it.skipIf(process.env.MOIRAI_EMBEDDING_INTEGRATION !== '1')('prepares new refinements after idle retirement and pressure recovery', async () => {
	const f = await fixture();
	const service = new EmbeddingService(f.semantic, { publish: () => {} }, path.resolve('apps/server/dist/embedding-model'));
	try {
		await f.embeddings();
		vi.useFakeTimers();
		service.start();
		const prepare = async (text: string) => {
			f.semantic.preferences.catalog([text]);
			service.requestPreferences();
			await vi.waitFor(() => expect(f.semantic.preferences.catalog([text])[text]?.status).toBe('ready'), { timeout: 10_000, interval: 100 });
			await vi.advanceTimersByTimeAsync(100);
		};
		await prepare('slow science fiction');
		await vi.advanceTimersByTimeAsync(60_000);
		await prepare('romantic comedies');
		await service.suspend();
		service.resume();
		await prepare('superhero movies');
	}
	finally {
		await service.close();
		vi.useRealTimers();
		await f.close();
	}
}, 40_000);
