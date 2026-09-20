import { PREFERENCE_DRAFT_LIMIT, PREFERENCE_BATCH_SIZE } from '@server/repository/semantic-preferences.js';
import { expect, it } from 'vitest';
import { similarityProgramConfigSchema } from '@moirai/shared';
import { rankSemanticCandidates, normalizeVector } from '@server/semantic/ranking.js';
import { passesSemanticExclusions, preferenceIssue, exclusionThreshold } from '@server/semantic/refinement.js';
import { semanticPreview, semanticExcludedPreview } from '@server/semantic/preview.js';
import { selectProgram } from '@server/scheduling/selection.js';
import { fixture, vector } from './fixtures.js';

it('soft preferences promote relevant themes without admitting unrelated candidates', () => {
	const candidates = [
		{ id: 'close', vector: normalizeVector([1, 0.1]) },
		{ id: 'preferred', vector: normalizeVector([1, 0.4]) },
		{ id: 'unrelated', vector: [0, 1] },
	];
	expect(rankSemanticCandidates([[1, 0]], candidates, 1, 0)).toEqual(['close']);
	expect(rankSemanticCandidates([[1, 0]], candidates, 5, 0, [], [0, 1])).toEqual(['preferred', 'close']);
	expect(rankSemanticCandidates([[1, 0]], [...candidates].reverse(), 5, 0, [], [0, 1])).toEqual(['preferred', 'close']);
});

it('validates and canonicalizes exclusions while preserving user spelling', () => {
	const config = similarityProgramConfigSchema.parse({ type: 'similarity', sourceProgramId: '00000000-0000-4000-8000-000000000001', hardExclusions: [' Superhero ', 'SUPERHERO', 'Comedy'] });
	expect(config.hardExclusions).toEqual(['SUPERHERO', 'Comedy']);
	expect(similarityProgramConfigSchema.safeParse({ ...config, softPreferences: 'x'.repeat(501) }).success).toBe(false);
	expect(similarityProgramConfigSchema.safeParse({ ...config, hardExclusions: [''] }).success).toBe(false);
});

it('persists preference vectors across restart, detects corruption, and distinguishes failure', async () => {
	const f = await fixture();
	try {
		const preferences = f.semantic.preferences;
		expect(preferences.catalog(['slow science fiction'])['slow science fiction']?.status).toBe('pending');
		const job = preferences.pending()[0]!;
		preferences.store(job.hash, vector());
		f.reopen();
		expect(f.semantic.preferences.catalog([job.text])[job.text]?.vector).toHaveLength(384);
		expect(f.semantic.preferences.pending()).toEqual([]);
		f.database.sqlite.prepare('UPDATE semantic_preferences SET embedding=?').run(Buffer.alloc(3));
		expect(f.semantic.preferences.catalog([job.text])[job.text]?.status).toBe('pending');
		f.semantic.preferences.store(job.hash, null);
		expect(f.semantic.preferences.catalog([job.text])[job.text]?.status).toBe('failed');
		expect(f.semantic.preferences.pending()).toEqual([]);
		f.database.sqlite.prepare("UPDATE semantic_preferences SET input_hash='old-model-identity'").run();
		expect(f.semantic.preferences.catalog([job.text])[job.text]?.status).toBe('pending');
	}
	finally {
		await f.close();
	}
});

it('applies exclusions to previews and future seeds, preserves active sets, and waits for preferences', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const first = selectProgram(f.program.id, f.key, new Map(), await f.context())!;
		const active = [...first.state.values()].find((row) => row.value.type === 'similarity')!.value;
		if (active.type !== 'similarity') {
			throw new Error('Expected semantic seed');
		}
		const excludedId = active.seed.itemIds[1]!;
		f.database.sqlite.prepare('UPDATE media_items SET metadata=? WHERE id=?').run(JSON.stringify({ tags: ['superhero'] }), excludedId);
		const config = similarityProgramConfigSchema.parse({ ...f.program.config, softPreferences: 'slow science fiction', hardExclusions: ['SUPERHERO'] });
		await f.repository.updateProgram(f.program.id, { config });
		f.repository.invalidateSchedulingCatalog();
		let context = await f.context();
		expect(preferenceIssue(config, context.catalog)).toContain('Preparing');
		expect(selectProgram(f.program.id, f.key, new Map(), context)).toBeNull();
		expect(context.issues.some((issue) => issue.message.includes('soft preference'))).toBe(true);
		expect(semanticPreview(config, [f.ids[0]!], context.catalog.media, context.catalog)).toEqual([]);
		const second = selectProgram(f.program.id, f.key, first.state, context)!;
		expect(second.media.id).toBe(excludedId);
		const third = selectProgram(f.program.id, f.key, second.state, context)!;
		f.commit([...third.state.values()]);
		f.reopen();
		await f.embeddings();
		// One candidate lies close to the exclusion concept without requiring any matching tag.
		const excludedInput = f.semantic.inputs([excludedId])[0]!;
		f.database.sqlite.prepare("UPDATE media_embeddings SET status='pending' WHERE media_id=?").run(excludedId);
		f.semantic.store(excludedInput, vector(0.9, Math.sqrt(1 - 0.9 ** 2)));
		for (const job of f.semantic.preferences.pending()) {
			f.semantic.preferences.store(job.hash, job.text === 'SUPERHERO' ? vector(0.35, Math.sqrt(1 - 0.35 ** 2)) : vector());
		}
		context = await f.context();
		const preview = semanticPreview(config, [f.ids[0]!], context.catalog.media.filter((item) => item.id !== f.ids[0]), context.catalog);
		expect(preview.length).toBeGreaterThan(0);
		expect(preview.map((item) => item.id)).not.toContain(excludedId);
		expect(semanticExcludedPreview(config, context.catalog.media, context.catalog).map((item) => item.id)).toEqual([excludedId]);
		const next = selectProgram(f.program.id, f.key, third.state, context)!;
		const nextValue = [...next.state.values()].find((row) => row.value.type === 'similarity')!.value;
		if (nextValue.type !== 'similarity') {
			throw new Error('Expected semantic seed');
		}
		expect(nextValue.seed.generation).toBe(2);
		expect(nextValue.seed.config).toEqual(config);
		expect(nextValue.seed.itemIds).not.toContain(excludedId);
		expect(f.semantic.seeds()[0]!.itemIds).toEqual(active.seed.itemIds);
	}
	finally {
		await f.close();
	}
});


it('bounds unsaved prompt work while retaining saved preferences', async () => {
	const f = await fixture();
	try {
		const config = similarityProgramConfigSchema.parse({ ...f.program.config, softPreferences: 'saved preference', hardExclusions: ['saved exclusion'] });
		await f.repository.updateProgram(f.program.id, { config });
		f.semantic.preferences.reconcile();
		f.semantic.preferences.catalog(Array.from({ length: PREFERENCE_DRAFT_LIMIT + 20 }, (_, index) => `draft ${index}`));
		expect(f.database.sqlite.prepare('SELECT COUNT(*) AS count FROM semantic_preferences').get()).toEqual({ count: PREFERENCE_DRAFT_LIMIT + 2 });
		expect(f.database.sqlite.prepare("SELECT status FROM semantic_preferences WHERE input_text='saved preference'").get()).toEqual({ status: 'pending' });
		expect(f.semantic.preferences.pending()).toHaveLength(PREFERENCE_BATCH_SIZE);
		f.semantic.preparationError('model-missing');
		expect(f.semantic.preferences.catalog(['saved preference'])['saved preference']?.error).toContain('matching model is missing');
	}
	finally {
		await f.close();
	}
});


it('excludes by concept similarity, with monotonic strictness and no reliance on tags', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const { catalog } = await f.context();
		const config = similarityProgramConfigSchema.parse({ ...f.program.config, hardExclusions: ['superhero movies'] });
		const media = { ...catalog.media[1]!, tags: [], genres: [], genreNames: [] };
		catalog.semantic!.preferences = { 'superhero movies': { status: 'ready', vector: vector() } };
		catalog.semantic!.vectors[media.id] = normalizeVector(vector(0.7, Math.sqrt(1 - 0.7 ** 2)));
		expect(passesSemanticExclusions(media, config, catalog)).toBe(false);
		expect(passesSemanticExclusions(media, { ...config, exclusionStrictness: 0 }, catalog)).toBe(true);
		expect(passesSemanticExclusions(media, { ...config, exclusionStrictness: 100 }, catalog)).toBe(false);
		expect(exclusionThreshold({ ...config, exclusionStrictness: 100 })).toBeLessThan(exclusionThreshold(config));
		catalog.semantic!.vectors[media.id] = vector(0, 1);
		expect(passesSemanticExclusions({ ...media, tags: ['superhero movies'] }, config, catalog)).toBe(true);
		catalog.semantic!.preferences['superhero movies'] = { status: 'pending' };
		expect(preferenceIssue(config, catalog)).toContain('Preparing the exclusion');
		catalog.semantic!.preferences['superhero movies'] = { status: 'failed' };
		expect(preferenceIssue(config, catalog)).toContain('Could not prepare the exclusion');
		expect(semanticPreview(config, [f.ids[0]!], catalog.media, catalog)).toEqual([]);
		expect(semanticExcludedPreview(config, catalog.media, catalog)).toEqual([]);
		expect(similarityProgramConfigSchema.safeParse({ ...config, exclusionStrictness: 101 }).success).toBe(false);
	}
	finally {
		await f.close();
	}
});


it('never falls back to excluded items when every candidate matches an exclusion', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const config = similarityProgramConfigSchema.parse({ ...f.program.config, hardExclusions: ['excluded concept'] });
		await f.repository.updateProgram(f.program.id, { config });
		f.semantic.preferences.reconcile();
		const job = f.semantic.preferences.pending()[0]!;
		f.semantic.preferences.store(job.hash, vector());
		const context = await f.context();
		expect(selectProgram(f.program.id, f.key, new Map(), context)).toBeNull();
		expect(context.issues.some((issue) => issue.message.includes('exclusions'))).toBe(true);
		expect(semanticPreview(config, [f.ids[0]!], context.catalog.media, context.catalog)).toEqual([]);
		expect(f.semantic.seeds()).toEqual([]);
	}
	finally {
		await f.close();
	}
});
