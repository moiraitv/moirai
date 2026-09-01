import type { MediaItem } from '@moirai/shared';

/** Freeze displayed indexed items followed by references that are currently missing. */
export function manualOrderFromDisplay(selectedIds: string[], displayed: MediaItem[]): string[] {
	const displayedIds = displayed.map((item) => item.id);
	const visible = new Set(displayedIds);
	return [...displayedIds, ...selectedIds.filter((itemId) => !visible.has(itemId))];
}

/** Restore loaded media to one authored identifier order while omitting missing records. */
export function itemsInReferenceOrder(itemIds: string[], items: MediaItem[]): MediaItem[] {
	const byId = new Map(items.map((item) => [item.id, item]));
	return itemIds.flatMap((itemId) => {
		const item = byId.get(itemId);
		return item ? [item] : [];
	});
}

/** Replace visible Manual positions while retaining missing references at the end. */
export function mergeVisibleManualOrder(currentIds: string[], visibleIds: string[]): string[] {
	const visible = new Set(visibleIds);
	return [...visibleIds, ...currentIds.filter((itemId) => !visible.has(itemId))];
}
