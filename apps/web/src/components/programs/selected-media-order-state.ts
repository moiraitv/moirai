import { computed, ref, type ComputedRef } from 'vue';
import {
	orderSelectedMedia,
	updateSelectedMediaAdditionOrder,
	type ContentSource,
	type MediaItem,
	type SelectedMediaSort,
} from '@moirai/shared';

/** Reactive insertion history and effective display order for one selected-media editor. */
export interface SelectedMediaOrderState {
	additionOrder: ComputedRef<{ itemIds: string[]; additionBatches: string[][] }>;
	orderedItems: ComputedRef<MediaItem[]>;
	reset: (source?: Extract<ContentSource, { type: 'collection' }>) => void;
}

/** Derive current insertion batches from the persisted source and unsaved item selection. */
export function useSelectedMediaOrderState(
	selectedItemIds: () => string[],
	selectedItems: () => MediaItem[],
	sort: () => SelectedMediaSort,
): SelectedMediaOrderState {
	const persistedItemIds = ref<string[]>([]);
	const persistedBatches = ref<string[][]>();
	const additionOrder = computed(() => updateSelectedMediaAdditionOrder(
		persistedItemIds.value,
		persistedBatches.value,
		selectedItemIds(),
	));
	const orderedItems = computed(() => orderSelectedMedia(
		selectedItems(),
		sort(),
		additionOrder.value.additionBatches,
	));

	/** Replace the persisted baseline when opening a program or changing its source. */
	function reset(source?: Extract<ContentSource, { type: 'collection' }>): void {
		persistedItemIds.value = source ? [...source.itemIds] : [];
		persistedBatches.value = source?.additionBatches?.map((batch) => [...batch]);
	}

	return { additionOrder, orderedItems, reset };
}
