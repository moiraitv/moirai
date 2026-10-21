import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { aiContentSelectionRequestSchema, programCreateSchema, MAX_EXCLUDED_MEDIA_ITEMS } from '@moirai/shared';
import { generateAiSelection } from '@server/ai/pipeline.js';
import { fixture } from '../semantic/fixtures.js';
import { schedulingProgramStatuses } from '@server/scheduling/status.js';
import { AiGenerations } from '@server/ai/generations.js';

it('deduplicates and bounds removals, permits empty AI selections and rejects selected/removed overlap', () => {
	const id = randomUUID();
	const source = { type: 'ai', libraryId: randomUUID(), prompt: 'Movies', itemIds: [], excludedItemIds: [id, id] };
	const program = programCreateSchema.parse({ name: 'AI', config: { type: 'content', source, strategy: { type: 'sequential' } } });
	expect(program.config).toMatchObject({ source: { itemIds: [], excludedItemIds: [id] } });
	expect(programCreateSchema.safeParse({ ...program, config: { ...program.config, source: { ...source, itemIds: [id] } } }).success).toBe(false);
	expect(aiContentSelectionRequestSchema.safeParse({ ...source, excludedItemIds: Array(MAX_EXCLUDED_MEDIA_ITEMS + 1).fill(id) }).success).toBe(false);
	expect(programCreateSchema.safeParse({ ...program, config: { ...program.config, source: { type: 'collection', libraryId: source.libraryId, itemIds: [] } } }).success).toBe(false);
});

it('excludes removed and aliased identities before paid review while preserving library coverage', async () => {
	const removed = randomUUID();
	const alias = randomUUID();
	const catalog = [
		{ id: removed, title: 'Removed movie', year: 2020, kind: 'movie', genres: [] },
		{ id: randomUUID(), title: 'Allowed movie', year: 2020, kind: 'movie', genres: [] },
		{ id: randomUUID(), title: 'Aliased removed movie', aliasIds: [alias], year: 2020, kind: 'movie', genres: [] },
	];
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		const text = body.messages[1].content as string;
		expect(text).not.toContain('Removed movie');
		expect(text).not.toContain('Aliased removed movie');
		return Response.json({ choices: [{ message: { content: JSON.stringify(text.includes('Rows:')
			? { matches: ['1'] } : { concepts: ['movies'], constraints: [], candidates: [] }) } }] });
	});
	const result = await generateAiSelection({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'test', webSearch: false }, 'Movies', 'movies', {
		loadCatalog: async () => catalog, excludedItemIds: [removed, alias], fetchImpl,
		loadVectors: async () => ({ vectors: {}, queries: [], available: false }),
	});
	expect(result.itemIds).toEqual([catalog[1]!.id]);
	expect(result.coverage).toMatchObject({ libraryCount: catalog.length, reviewedCount: 1 });
});

it.each([false, true])('reports eligible embedding coverage when the allowed item has a vector: %s', async (allowedHasVector) => {
	const removed = randomUUID();
	const allowed = randomUUID();
	const catalog = [
		{ id: removed, title: 'Removed movie', year: 2020, kind: 'movie', genres: [] },
		{ id: allowed, title: 'Allowed movie', year: 2020, kind: 'movie', genres: [] },
	];
	const result = await generateAiSelection({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'test', webSearch: false }, 'Movies', 'movies', {
		loadCatalog: async () => catalog, excludedItemIds: [removed],
		loadVectors: async () => ({ vectors: { [allowedHasVector ? allowed : removed]: [1, 0] }, queries: [[1, 0]], available: false }),
		fetchImpl: async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			return Response.json({ choices: [{ message: { content: JSON.stringify(body.messages[1].content.includes('Rows:')
				? { matches: ['1'] } : { concepts: ['movies'], constraints: [], candidates: [] }) } }] });
		},
	});
	expect(result.itemIds).toEqual([allowed]);
	expect(result.coverage).toMatchObject({ mediaEmbeddingsAvailable: allowedHasVector,
		embeddingsAvailable: allowedHasVector, queryEmbeddingsAvailable: true });
});

it('requires a fresh retained generation identity when removals change', async () => {
	const jobs = new AiGenerations();
	try {
		const request = { id: randomUUID(), libraryId: randomUUID(), prompt: 'Movies' };
		const run = vi.fn(async () => ({ itemIds: [], unmatched: [], catalogTruncated: false }));
		jobs.start('owner', request, run);
		expect(() => jobs.start('owner', { ...request, excludedItemIds: [randomUUID()] }, run)).toThrow();
		await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
	}
	finally {
		await jobs.close();
	}
});


it.each(['date-added', 'manual'] as const)('saves and reloads an empty %s AI program with removed references and empty health', async (order) => {
	const f = await fixture();
	try {
		const removed = randomUUID();
		const program = await f.repository.createProgram(programCreateSchema.parse({ name: 'Empty AI', config: {
			type: 'content', source: { type: 'ai', libraryId: f.library.id, prompt: 'Movies', itemIds: [], excludedItemIds: [removed],
				sort: order === 'manual' ? { type: 'manual', itemIds: [] } : { type: 'date-added', direction: 'asc' } },
			strategy: { type: 'sequential' },
		} }));
		f.reopen();
		expect((await f.repository.getProgram(program.id))?.config).toMatchObject({ source: { itemIds: [], excludedItemIds: [removed] } });
		const context = await f.context();
		expect(schedulingProgramStatuses([...context.programs.values()], context.catalog).find((status) => status.programId === program.id)).toMatchObject({ health: 'empty', availableItemCount: 0 });
	}
	finally {
		await f.close();
	}
});
