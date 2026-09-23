import { SchedulingWorkerPool } from '@server/scheduling/worker-pool.js';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { expect, it } from 'vitest';
import { programCreateSchema, themeProgramConfigSchema } from '@moirai/shared';
import { selectionStateRecordSchema } from '@moirai/shared/api-contracts';
import { SemanticPreferenceRepository, PREFERENCE_DRAFT_LIMIT } from '@server/repository/semantic-preferences.js';
import { registerSemanticProgramRoutes } from '@server/routes/semantic-programs.js';
import { publicError } from '@server/routes/public-errors.js';
import { responseSerializerCompiler } from '@server/routes/contracts.js';
import { selectProgram } from '@server/scheduling/selection.js';
import { similarityProgramStatus } from '@server/semantic/status.js';
import { fixture, vector } from './fixtures.js';

it('prepares themes, scopes candidates, applies exclusions, and preserves committed membership across edits and restart', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const config = themeProgramConfigSchema.parse({ type: 'theme', libraryId: f.library.id, theme: '  Space exploration  ', quantity: 2, hardExclusions: ['war'] });
		const program = await f.repository.createProgram(programCreateSchema.parse({ name: 'Space', config }));
		let context = await f.context();
		const status = () => similarityProgramStatus(context.programs.get(program.id)!, [...context.programs.values()], context.catalog);
		expect(status()).toMatchObject({ previewPending: true, previewItems: [] });
		expect(selectProgram(program.id, f.key, new Map(), context)).toBeNull();
		const preferences = new SemanticPreferenceRepository(f.database.db);
		preferences.reconcile();
		for (const entry of preferences.pending()) {
			preferences.store(entry.hash, entry.text === 'war' ? vector(0, 1) : vector());
		}
		// Saved themes survive eviction of many unrelated draft concepts.
		preferences.catalog(Array.from({ length: PREFERENCE_DRAFT_LIMIT + 10 }, (_, index) => `Draft ${index}`));
		expect(preferences.catalog([config.theme])[config.theme]?.status).toBe('ready');
		f.repository.invalidateSchedulingCatalog();
		context = await f.context();
		context.catalog.semantic!.vectors[f.ids[0]!] = vector(0, 1);
		const outsider = { ...context.catalog.media[1]!, id: randomUUID(), libraryId: randomUUID() };
		context.catalog.media.push(outsider);
		context.catalog.semantic!.vectors[outsider.id] = vector();
		expect(status().previewItems).toHaveLength(2);
		expect(status().excludedPreviewItems?.map((item) => item.id)).toContain(f.ids[0]);
		expect(status().previewItems.map((item) => item.id)).not.toContain(outsider.id);
		const first = selectProgram(program.id, f.key, new Map(), context)!;
		const record = first.state.get(f.key)!;
		expect(selectionStateRecordSchema.parse(record)).toMatchObject({ value: { seed: { config: { type: 'theme' }, sourceItemIds: [] } } });
		f.commit([...first.state.values()]);
		await f.repository.updateProgram(program.id, { config: { ...config, theme: 'Ocean voyages', quantity: 1 } });
		f.reopen();
		context = await f.context();
		const second = selectProgram(program.id, f.key, first.state, context)!;
		expect(second).not.toBeNull();
		expect(second.media.id).not.toBe(first.media.id);
		expect(second.state.get(f.key)?.value).toMatchObject({ seed: { generation: 1, config: { theme: 'Space exploration', quantity: 2 } } });
		expect(selectProgram(program.id, f.key, second.state, context)).toBeNull();
		const nextPreferences = new SemanticPreferenceRepository(f.database.db);
		while (nextPreferences.pending().length) {
			for (const entry of nextPreferences.pending()) {
				nextPreferences.store(entry.hash, vector());
			}
		}
		f.repository.invalidateSchedulingCatalog();
		context = await f.context();
		const third = selectProgram(program.id, f.key, second.state, context)!;
		expect(third.state.get(f.key)?.value).toMatchObject({ seed: { generation: 2, config: { theme: 'Ocean voyages', quantity: 1 } } });
		const scoped = await f.repository.getSchedulingCatalog([...context.programs.values()], [f.source.id]);
		expect(scoped.semantic).toBeUndefined();
	}
	finally {
		await f.close();
	}
});

it('validates theme drafts and retries failed theme vectors through the semantic endpoints', async () => {
	const f = await fixture();
	const app = Fastify();
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		reply.status(mapped.statusCode).send(mapped.body);
	});
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	await app.register(sensible);
	registerSemanticProgramRoutes(app, f.repository, undefined, new SchedulingWorkerPool(0, 4, { db: f.database.db, repository: f.repository }));
	try {
		await f.embeddings();
		const config = { type: 'theme', libraryId: f.library.id, theme: 'Space exploration', quantity: 1 };
		const preview = () => app.inject({ method: 'POST', url: '/api/v1/programs/similarity-preview', payload: config });
		expect((await preview()).json()).toMatchObject({ previewPending: true, previewItems: [] });
		const preferences = new SemanticPreferenceRepository(f.database.db);
		preferences.store(preferences.pending()[0]!.hash, null);
		f.repository.invalidateSchedulingCatalog();
		expect((await preview()).json()).toMatchObject({ previewPending: false, failedEmbeddingCount: 1 });
		const retry = await app.inject({ method: 'POST', url: '/api/v1/programs/similarity-retry', payload: config });
		expect(retry.json()).toEqual({ queued: 1 });
		preferences.store(preferences.pending()[0]!.hash, vector());
		f.repository.invalidateSchedulingCatalog();
		expect((await preview()).json().previewItems).toHaveLength(1);
		for (const invalid of [{ ...config, theme: ' ' }, { ...config, libraryId: randomUUID() }]) {
			expect((await app.inject({ method: 'POST', url: '/api/v1/programs/similarity-preview', payload: invalid })).statusCode).toBe(400);
		}
		expect(f.semantic.seeds()).toEqual([]);
	}
	finally {
		await app.close();
		await f.close();
	}
});
