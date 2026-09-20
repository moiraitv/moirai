import { expect, it } from 'vitest';
import { selectProgram } from '@server/scheduling/selection.js';
import { fixture } from './fixtures.js';

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
