import { describe, expect, it } from 'vitest';
import type { MediaItem } from '@moirai/shared';
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

	it('restores loaded items to authored order while omitting missing records', () => {
		expect(itemsInReferenceOrder(['two', 'missing', 'one'], [item('one'), item('two')]))
			.toEqual([item('two'), item('one')]);
	});

	it('merges reordered visible items ahead of retained missing references', () => {
		expect(mergeVisibleManualOrder(['one', 'two', 'missing'], ['two', 'one']))
			.toEqual(['two', 'one', 'missing']);
	});
});
