import { describe, expect, it } from 'vitest';
import { orderSelectedMedia, type MediaItem } from '@moirai/shared';
import {
	itemsInReferenceOrder,
	manualOrderFromDisplay,
	mergeVisibleManualOrder,
} from '@web/components/programs/selected-media-order';

/** Build the minimum media item used by selected-order helpers. */
function item(id: string): MediaItem {
	return { id } as MediaItem;
}

describe('selected media editor ordering', () => {
	it('freezes visible order and retains missing references at the end', () => {
		expect(manualOrderFromDisplay(['one', 'missing', 'two'], [item('two'), item('one')]))
			.toEqual(['two', 'one', 'missing']);
	});

	it('freezes the effective episode order before manual reordering and retains missing IDs', () => {
		const media = [10, 2, 1].map(number => ({ ...item(String(number)), sortTitle: String(number), year: null, showId: 'show', showSortTitle: 'Show', seasonNumber: 1, episodeNumber: number }));
		const displayed = orderSelectedMedia(media, { type: 'episode', direction: 'asc' });
		expect(manualOrderFromDisplay(['10', 'missing', '2', '1'], displayed)).toEqual(['1', '2', '10', 'missing']);
	});

	it('restores loaded items to authored order while omitting missing records', () => {
		expect(itemsInReferenceOrder(['two', 'missing', 'one'], [item('one'), item('two')]))
			.toEqual([item('two'), item('one')]);
	});

	it('merges reordered visible items ahead of retained missing references', () => {
		expect(mergeVisibleManualOrder(['one', 'two', 'missing'], ['two', 'one']))
			.toEqual(['two', 'one', 'missing']);
	});
});
