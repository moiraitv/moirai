import { computed, ref, type Ref, type ComputedRef } from 'vue';
import type { MediaBrowseEntry } from '@moirai/shared';

/** Keep page-local selections homogeneous so group references never become individual items. */
export function useCatalogSelection(entries: ComputedRef<MediaBrowseEntry[]>, selectedIds: Ref<string[]>) {
	const selectionKind = ref<'items' | 'groups'>('items');
	const hasGroups = computed(() => entries.value.some((entry) => entry.group));
	const hasItems = computed(() => entries.value.some((entry) => entry.item));
	const pageSelectionIds = computed(() => [
		...new Set(entries.value.flatMap((entry) => selectionKind.value === 'groups' ? (entry.group ? [entry.group.id] : []) : (entry.item ? [entry.item.id] : []))),
	]);
	const selectedIdSet = computed(() => new Set(selectedIds.value));
	const allPageSelected = computed(() =>
		pageSelectionIds.value.length > 0
		&& pageSelectionIds.value.every((entryId) => selectedIdSet.value.has(entryId)));

	/** Toggle one card in the current page-local selection. */
	function toggleSelectedEntry(entryId: string): void {
		selectedIds.value = selectedIdSet.value.has(entryId)
			? selectedIds.value.filter((candidate) => candidate !== entryId)
			: [...selectedIds.value, entryId];
	}

	/** Select or clear every eligible card on the current catalog page. */
	function togglePageSelection(): void {
		selectedIds.value = allPageSelected.value ? [] : [...pageSelectionIds.value];
	}

	return { selectionKind, hasGroups, hasItems, pageSelectionIds, selectedIdSet, allPageSelected,
		toggleSelectedEntry, togglePageSelection };
}
