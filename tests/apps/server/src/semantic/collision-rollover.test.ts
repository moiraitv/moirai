import { expect, it } from 'vitest';
import { indexOccupiedMedia, selectProgram } from '@server/scheduling/selection.js';
import { programCreateSchema } from '@moirai/shared';
import { fixture, vector } from './fixtures.js';

it.each([
	{ type: 'similarity', remaining: 1 }, { type: 'theme', remaining: 1 },
	{ type: 'similarity', remaining: 3 }, { type: 'theme', remaining: 3 },
] as const)('starts the next $type set with $remaining colliding items left and persists it', async ({ type, remaining }) => {
	const f = await fixture();
	try {
		await f.embeddings();
		const program = type === 'theme'
			? await f.repository.createProgram(programCreateSchema.parse({ name: 'Theme', config: { type, libraryId: f.library.id, theme: 'Drama', quantity: 3 } }))
			: f.program;
		const context = await f.context();
		if (type === 'theme') {
			context.catalog.semantic!.preferences = { ...context.catalog.semantic!.preferences, Drama: { status: 'ready', vector: vector() } };
		}
		// Exercise the stable semantic key used by a nested, daily sequence occurrence.
		const consumer = `${f.key}:2026-09-19:entry:movies`;
		const key = `${f.key}:entry:movies:program:${program.id}`;
		const initial = selectProgram(program.id, consumer, new Map(), context)!;
		const value = initial.state.get(key)!.value;
		if (value.type !== 'similarity') {
			throw new Error('Expected semantic state');
		}
		value.consumedItemIds = value.seed.itemIds.slice(0, -remaining);
		const colliding = value.seed.itemIds.slice(-remaining);
		context.occupiedMedia = colliding.map(mediaItemId => ({ mediaItemId, start: context.selectionStart, finish: '2026-09-19T13:00:00Z' }));
		context.occupiedMediaIndex = indexOccupiedMedia(context.occupiedMedia);
		const baseline = structuredClone(initial.state);

		const next = selectProgram(program.id, consumer, initial.state, context)!;
		expect(colliding).not.toContain(next.media.id);
		expect(next.state.get(key)?.value).toMatchObject({ seed: { generation: value.seed.generation + 1 },
			recentSeeds: [value.seed.itemIds], consumedItemIds: [next.media.id] });
		expect(initial.state).toEqual(baseline);
		f.commit([...next.state.values()]);
		f.reopen();
		const persisted = (await f.repository.getSelectionState(f.channel.id)).find(record => record.consumerKey === key)!;
		expect(persisted.value).toEqual(next.state.get(key)!.value);
		expect(f.semantic.seeds().find(seed => seed.consumerKey === key)?.generation).toBe(value.seed.generation + 1);
	}
	finally {
		await f.close();
	}
});

it.each(['conflicts', 'unprepared', 'too-long'] as const)('keeps the original fallback when the next set is %s', async failure => {
	const f = await fixture();
	try {
		await f.embeddings();
		const context = await f.context();
		const initial = selectProgram(f.program.id, f.key, new Map(), context)!;
		const value = initial.state.get(f.key)!.value;
		if (value.type !== 'similarity') {
			throw new Error('Expected semantic state');
		}
		value.consumedItemIds = value.seed.itemIds.slice(0, -1);
		const last = value.seed.itemIds.at(-1)!;
		const other = context.catalog.media.find(media => !value.seed.itemIds.includes(media.id) && media.id !== f.ids[0])!;
		context.catalog.semantic!.seeds.push({ ...value.seed, generation: value.seed.generation + 1, itemIds: [other.id] });
		// A safe third batch must not cause another rollover in the same selection.
		context.catalog.semantic!.seeds.push({ ...value.seed, generation: value.seed.generation + 2, itemIds: [f.ids[0]!] });
		context.occupiedMedia = [{ mediaItemId: last, start: context.selectionStart, finish: '2026-09-19T13:00:00Z' }];
		if (failure === 'conflicts') {
			context.occupiedMedia.push({ ...context.occupiedMedia[0]!, mediaItemId: other.id });
		}
		else if (failure === 'unprepared') {
			context.catalog.semantic!.seeds = [];
			context.catalog.semantic!.vectors = {};
		}
		else {
			other.durationSeconds = 120;
		}
		const baseline = structuredClone(initial.state);
		const next = selectProgram(f.program.id, f.key, initial.state, context, 60, 'first-fit-arbitrary')!;
		expect(next.media.id).toBe(last);
		expect(next.state.get(f.key)?.value).toMatchObject({ seed: value.seed, consumedItemIds: value.seed.itemIds });
		expect(initial.state).toEqual(baseline);
		expect(context.issues).toEqual([]);
		expect(context.blockedPrograms.size).toBe(0);
		expect(context.fitRejectionCount).toBe(0);
	}
	finally {
		await f.close();
	}
});

it.each(['alternative', 'opt-out', 'filler', 'unavailable', 'fit'] as const)('does not end the batch for %s', async scenario => {
	const f = await fixture();
	try {
		await f.embeddings();
		const context = await f.context();
		const initial = selectProgram(f.program.id, f.key, new Map(), context)!;
		const value = initial.state.get(f.key)!.value;
		if (value.type !== 'similarity') {
			throw new Error('Expected semantic state');
		}
		value.consumedItemIds = [];
		context.occupiedMedia = value.seed.itemIds.map(mediaItemId => ({ mediaItemId, start: context.selectionStart, finish: '2026-09-19T13:00:00Z' }));
		if (scenario === 'alternative') {
			context.occupiedMedia.pop();
		}
		else if (scenario === 'opt-out') {
			context.avoidCrossChannelDuplicates = false;
		}
		else if (scenario === 'filler') {
			context.fillerSelection = { fullBudgetSeconds: 60, allowTruncation: false };
		}
		else if (scenario === 'unavailable') {
			context.catalog.media.find(media => media.id === value.seed.itemIds[0])!.availability = 'unconfirmed';
		}
		else {
			context.occupiedMedia = [];
		}
		const next = selectProgram(f.program.id, f.key, initial.state, context, scenario === 'fit' ? 30 : 60, 'first-fit-arbitrary');
		if (scenario === 'fit') {
			expect(next).toBeNull();
			expect(context.fitRejectionCount).toBe(1);
		}
		else {
			expect(next!.state.get(f.key)?.value).toMatchObject({ seed: value.seed });
			expect(value.seed.itemIds).toContain(next!.media.id);
		}
	}
	finally {
		await f.close();
	}
});
