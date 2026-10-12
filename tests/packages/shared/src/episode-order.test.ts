import { describe, expect, it } from 'vitest';
import { orderSelectedMedia, selectedMediaSortSchema, contentSourceSchema } from '@moirai/shared';

function episode(id: string, seasonNumber: number | null, episodeNumber: number | null, showId: string | null = 'alpha', showSortTitle: string | null = 'Alpha') {
	return { id, sortTitle: id, year: null, showId, showSortTitle, seasonNumber, episodeNumber };
}

const episodes = [episode('ten', 1, 10), episode('two', 1, 2), episode('special', 0, 1), episode('later-season', 2, 1), episode('missing-episode', 1, null), episode('missing-season', null, 1)];

describe('selected episode order', () => {
	it('compares numeric season/episode metadata and retains specials', () => {
		expect(orderSelectedMedia(episodes, { type: 'episode', direction: 'asc' }).map(item => item.id))
			.toEqual(['special', 'two', 'ten', 'missing-episode', 'later-season', 'missing-season']);
	});

	it('reverses episode order while keeping missing metadata last at each level', () => {
		expect(orderSelectedMedia(episodes, { type: 'episode', direction: 'desc' }).map(item => item.id))
			.toEqual(['later-season', 'ten', 'two', 'missing-episode', 'special', 'missing-season']);
	});

	it.each(['asc', 'desc'] as const)('groups identically named shows by identity and keeps shows alphabetical (%s)', direction => {
		const items = [episode('zulu', 0, 1, 'z', 'Zulu'), episode('alpha-b', 1, 1, 'b', 'Alpha'), episode('alpha-a-two', 1, 2, 'a'), episode('unknown', 0, 0, null, null), episode('alpha-a-one', 1, 1, 'a')];
		expect(orderSelectedMedia(items, { type: 'episode', direction }).map(item => item.id))
			.toEqual(direction === 'asc' ? ['alpha-a-one', 'alpha-a-two', 'alpha-b', 'zulu', 'unknown'] : ['alpha-a-two', 'alpha-a-one', 'alpha-b', 'zulu', 'unknown']);
	});

	it('retains insertion order for equal keys without mutating the input', () => {
		const items = [episode('second', 1, 1), episode('first', 1, 1)];
		expect(orderSelectedMedia(items, { type: 'episode', direction: 'desc' })).toEqual(items);
		expect(items.map(item => item.id)).toEqual(['second', 'first']);
	});

	it('accepts episode sorting while preserving the legacy omitted-sort default', () => {
		expect(selectedMediaSortSchema.parse({ type: 'episode', direction: 'asc' })).toEqual({ type: 'episode', direction: 'asc' });
		expect(contentSourceSchema.parse({ type: 'collection', libraryId: '00000000-0000-4000-8000-000000000001', itemIds: ['00000000-0000-4000-8000-000000000002'] })).toMatchObject({ sort: { type: 'date-added', direction: 'asc' } });
	});
});
