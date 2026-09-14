import { computed, ref } from 'vue';
import { expect, it } from 'vitest';
import type { MediaBrowseEntry } from '@moirai/shared';
import { useCatalogSelection } from '../../../../apps/web/src/composables/useCatalogSelection';

it('selects only the chosen entry kind on mixed pages', () => {
	const entries = computed(() => [
		{ key: 'group', group: { id: 'season' } },
		{ key: 'item', item: { id: 'episode' } },
	] as unknown as MediaBrowseEntry[]);
	const selected = ref<string[]>([]);
	const selection = useCatalogSelection(entries, selected);
	expect(selection.hasGroups.value).toBe(true);
	expect(selection.hasItems.value).toBe(true);
	selection.togglePageSelection();
	expect(selected.value).toEqual(['episode']);
	selection.selectionKind.value = 'groups';
	selection.togglePageSelection();
	expect(selected.value).toEqual(['season']);
	expect(selection.allPageSelected.value).toBe(true);
	selection.toggleSelectedEntry('season');
	expect(selected.value).toEqual([]);
	expect(selection.allPageSelected.value).toBe(false);
});
