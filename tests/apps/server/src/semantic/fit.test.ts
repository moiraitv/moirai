import { expect, it } from 'vitest';
import { indexOccupiedMedia, selectProgram } from '@server/scheduling/selection.js';
import { fixture } from './fixtures.js';

it.each([false, true])('avoids expanded mid-roll collisions with indexed occupancy: %s', async (indexed) => {
	const f = await fixture();
	try {
		await f.embeddings();
		const context = await f.context();
		const first = selectProgram(f.program.id, f.key, new Map(), context)!;
		const value = first.state.get(f.key)!.value;
		if (value.type !== 'similarity') {
			throw new Error('Expected semantic seed');
		}
		const [colliding, alternative] = value.seed.itemIds;
		value.consumedItemIds = [];
		context.mediaDuration = media => media.id === colliding ? 120 : media.durationSeconds!;
		context.occupiedMedia = [{ mediaItemId: colliding!, start: '2026-09-19T12:01:30Z', finish: '2026-09-19T12:01:40Z' }];
		if (indexed) {
			context.occupiedMediaIndex = indexOccupiedMedia(context.occupiedMedia);
		}

		expect(selectProgram(f.program.id, f.key, first.state, context, 180, 'first-fit-arbitrary')?.media.id).toBe(alternative);
		expect(value.consumedItemIds).toEqual([]);
	}
	finally {
		await f.close();
	}
});

it('preserves primary order and chooses the longest fitting remaining item for filler', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const context = await f.context();
		const first = selectProgram(f.program.id, f.key, new Map(), context)!;
		const value = first.state.get(f.key)!.value;
		if (value.type !== 'similarity') {
			throw new Error('Expected semantic seed');
		}
		const [long, short, best] = value.seed.itemIds;
		context.catalog.media.find((media) => media.id === long)!.durationSeconds = 90;
		context.catalog.media.find((media) => media.id === short)!.durationSeconds = 20;
		context.catalog.media.find((media) => media.id === best)!.durationSeconds = 55;
		value.consumedItemIds = [];
		const baseline = structuredClone(first.state);

		expect(selectProgram(f.program.id, f.key, first.state, context, 60, 'first-fit-arbitrary')).toBeNull();
		expect(context.fitRejectionCount).toBe(1);
		expect(first.state).toEqual(baseline);
		const filler = selectProgram(f.program.id, f.key, first.state, context, 60, 'best-fit')!;
		expect(filler.media.id).toBe(best);
		expect(filler.state.get(f.key)?.value).toMatchObject({ consumedItemIds: [best] });
		expect(selectProgram(f.program.id, f.key, filler.state, context)?.media.id).toBe(long);

		// Equal-duration filler retains seed order, and concurrent playback is avoided first.
		context.catalog.media.find((media) => media.id === best)!.durationSeconds = 20;
		expect(selectProgram(f.program.id, f.key, first.state, context, 60, 'best-fit')?.media.id).toBe(short);
		context.occupiedMedia = [{ mediaItemId: long!, start: context.selectionStart, finish: '2026-09-19T12:05:00Z' }];
		expect(selectProgram(f.program.id, f.key, first.state, context, 60, 'first-fit-arbitrary')?.media.id).toBe(short);
	}
	finally {
		await f.close();
	}
});

it('carries oversized semantic filler ahead of new sets and persists its independent cycle', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const context = await f.context();
		const initial = selectProgram(f.program.id, f.key, new Map(), context)!;
		const value = initial.state.get(f.key)!.value;
		if (value.type !== 'similarity') {
			throw new Error('Expected semantic seed');
		}
		const [long, first, second] = value.seed.itemIds;
		context.catalog.media.find(media => media.id === long)!.durationSeconds = 200;
		context.catalog.media.find(media => media.id === first)!.durationSeconds = 30;
		context.catalog.media.find(media => media.id === second)!.durationSeconds = 40;
		value.consumedItemIds = [];
		context.fillerSelection = { fullBudgetSeconds: 70, allowTruncation: false };
		const baseline = structuredClone(initial.state);
		const a = selectProgram(f.program.id, f.key, initial.state, context, 70)!;
		const b = selectProgram(f.program.id, f.key, a.state, context, 40)!;
		expect([a.media.id, b.media.id]).toEqual([first, second]);
		expect(initial.state).toEqual(baseline);
		expect(b.state.get(f.key)!.value.fillerCycle!.remainingItemIds).toEqual([long]);
		const c = selectProgram(f.program.id, f.key, b.state, context, 70)!;
		expect(c.media.id).not.toBe(long);
		const pending = c.state.get(f.key)!.value.fillerCycle!.remainingItemIds;
		expect(pending[0]).toBe(long);
		expect(new Set(pending).size).toBe(pending.length);
		f.commit([...c.state.values()]);
		f.reopen();
		const persisted = await f.repository.getSelectionState(f.channel.id);
		expect(persisted.find(record => record.consumerKey === f.key)?.value.fillerCycle).toEqual(c.state.get(f.key)!.value.fillerCycle);
		context.fillerSelection.fullBudgetSeconds = 200;
		expect(selectProgram(f.program.id, f.key, c.state, context, 200)?.media.id).toBe(long);
	}
	finally {
		await f.close();
	}
});
