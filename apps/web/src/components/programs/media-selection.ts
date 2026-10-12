import type { MediaGroup, MediaItem, SelectedMediaSort } from '@moirai/shared';

/** Selected-media review shared by the inline playback editor and modal drawer. */
export interface MediaSelectionProps {
	selectingGroups: boolean;
	aiSelection?: boolean;
	selectionCount: number;
	selectionLimit: number;
	loading: boolean;
	loaded: boolean;
	missingItemCount: number;
	missingGroupCount: number;
	items: MediaItem[];
	groups: MediaGroup[];
	selectedItemCount: number;
	selectedGroupCount: number;
	itemReferenceCount: number;
	groupReferenceCount: number;
	libraryType: string;
	search: string;
	sort: SelectedMediaSort;
}

/** Draft mutations emitted by either selected-media presentation. */
export type MediaSelectionEvents = {
	retry: [];
	clear: [];
	removeItem: [id: string];
	removeGroup: [id: string];
	moveItem: [id: string, offset: -1 | 1];
	reorderItems: [itemIds: string[]];
	'update:search': [value: string];
	'update:sortType': [value: 'date-added' | 'name' | 'release-date' | 'episode' | 'manual'];
	'update:sortDirection': [value: 'asc' | 'desc'];
};
