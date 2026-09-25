<script setup lang="ts">
import SequenceGuidePreview from './SequenceGuidePreview.vue';
import type { SequenceOrdering } from '@moirai/shared';
import SequenceOrderingEditor from './SequenceOrderingEditor.vue';
import ResourceUsage from '../ResourceUsage.vue';
import { useDraftProtection } from '../../draft-protection';
import PageHelpButton from '../PageHelpButton.vue';
import { useDisclosureState } from '../../disclosure-state';
import FormDisclosure from '../FormDisclosure.vue';
import AudioPreferencesEditor from '../AudioPreferencesEditor.vue';
import SubtitlePreferencesEditor from '../SubtitlePreferencesEditor.vue';
import type { AudioPreferences, SubtitlePreferences } from '@moirai/shared';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Asterisk, ChevronDown } from '@lucide/vue';
import {
	catalogProgramItemFilterSchema,
	MAX_EXPLICIT_MEDIA_GROUPS,
	type MediaGenreFacet,
	type MediaGroup,
	type MediaItem,
	type MediaSourcePickerEntry,
	type ProgramCreate,
	type SchedulingProgram,
	type SelectedMediaSort,
} from '@moirai/shared';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import { cloneContractValue } from '../../reactive-clone';
import LoadingState from '../../components/LoadingState.vue';
import ResourceEditorActionBar from '../../components/ResourceEditorActionBar.vue';
import ResourceEditorHeader from '../../components/ResourceEditorHeader.vue';
import { mediaGroupSubtitle, mediaItemSubtitle } from '../../media-labels';
import { useLibrariesStore } from '../../stores/libraries';
import { useChannelsStore } from '../../stores/channels';
import { useSchedulingStore } from '../../stores/scheduling';
import { artworkSrcset, artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';
import { randomUuid } from '../../random-uuid';
import { closeUnsavedEditor } from '../../unsaved-editor';
import MediaSelectionDrawer from './MediaSelectionDrawer.vue';
import ProgramTypeRail from './ProgramTypeRail.vue';
import ProgramSourceBrowser from './ProgramSourceBrowser.vue';
import SelectionStrategyEditor from './SelectionStrategyEditor.vue';
import { DEFAULT_SIMILARITY_QUANTITY, DEFAULT_SEMANTIC_EXCLUSION_STRICTNESS, DEFAULT_SIMILARITY_VARIETY } from '@moirai/shared';
import SimilarityProgramEditor from './SimilarityProgramEditor.vue';
import SequenceProgramEditor from './SequenceProgramEditor.vue';
import { itemsInReferenceOrder, manualOrderFromDisplay, mergeVisibleManualOrder } from './selected-media-order';
import { useSelectedMediaOrderState } from './selected-media-order-state';
import { subscribeToSelectedMediaRefresh } from './selected-media-refresh';
import { isProgramDraftValid } from './program-save-state';
import { useProgramResourceActions } from './program-resource-actions';
import ProgramLibraryQuery from './ProgramLibraryQuery.vue';
import { emptyCatalogProgramItemFilter } from '../library/library-filter';

const props = withDefaults(
	defineProps<{
		embedded?: boolean;
		programId?: string | null;
	}>(),
	{ embedded: false, programId: null },
);
const emit = defineEmits<{
	close: [];
	saved: [programId: string];
}>();
const route = useRoute();
const router = useRouter();
const scheduling = useSchedulingStore();
const librariesStore = useLibrariesStore();
const channelsStore = useChannelsStore();
const initialLoading = ref(true);
const saving = ref(false);
let allowRouteLeave = false;
const error = ref('');
const sourceEntries = ref<MediaSourcePickerEntry[]>([]);
const sourceLoading = ref(false);
const sourceLoaded = ref(false);
let sourceLoadSequence = 0;
const sourceParentId = ref<string>();
const sourcePage = ref(1);
const sourceTotalPages = ref(1);
const sourceSearch = ref('');
const subtitlesOpen = useDisclosureState('program-subtitles');
const sourceBrowserOpen = useDisclosureState('program-source-browser', true);
const selectedSourceLabel = ref('');
const selectedItems = ref<MediaItem[]>([]);
const selectedGroups = ref<MediaGroup[]>([]);
const selectedItemsLoading = ref(false);
const selectedItemsLoaded = ref(false);
const selectedGroupsLoading = ref(false);
const selectedGroupsLoaded = ref(false);
const selectionDrawerOpen = ref(false);
const selectedItemSearch = ref('');
const selectionReviewButton = ref<HTMLButtonElement>();
let selectedItemsLoadSequence = 0;
let selectedGroupsLoadSequence = 0;
let unsubscribeLiveEvents: (() => void) | undefined;
const genres = ref<MediaGenreFacet[]>([]);
const queryPreviewRevision = ref(0);
const editorOpen = computed(() =>
	props.embedded ? Boolean(props.programId) : route.params.id !== undefined);
const editingId = computed(() =>
	props.embedded
		? props.programId
		: route.params.id === 'new'
			? null
			: String(route.params.id ?? ''));
const programs = computed(() => scheduling.overview?.programs ?? []);
const statuses = computed(
	() =>
		new Map(
			(scheduling.overview?.programStatuses ?? []).map((status) => [status.programId, status]),
		),
);
const selectedIdSet = computed(() => new Set(form.selectedItemIds));
const selectedGroupIdSet = computed(() => new Set(form.selectedGroupIds));
const selectingGroups = computed(() => form.sourceType === 'group-collection');
const selectionCount = computed(() =>
	selectingGroups.value ? form.selectedGroupIds.length : form.selectedItemIds.length);
const selectionLimit = computed(() =>
	selectingGroups.value ? MAX_EXPLICIT_MEDIA_GROUPS : channelsStore.maxExplicitMediaItems);
const missingSelectedCount = computed(() => form.selectedItemIds.length - selectedItems.value.length);
const selectedItemSort = computed<SelectedMediaSort>(() => form.selectedItemSort === 'manual'
	? { type: 'manual', itemIds: form.manualItemIds }
	: { type: form.selectedItemSort, direction: form.selectedItemSortDirection });
const selectedItemOrdering = useSelectedMediaOrderState(
	() => form.selectedItemIds,
	() => selectedItems.value,
	() => selectedItemSort.value,
);
const filteredSelectedItems = computed(() => {
	const query = selectedItemSearch.value.trim().toLocaleLowerCase();
	if (!query) {
		return selectedItemOrdering.orderedItems.value;
	}

	return selectedItemOrdering.orderedItems.value.filter((item) => {
		const subtitle = mediaItemSubtitle(selectedLibraryType.value, item) || item.kind;
		return `${item.title} ${subtitle}`.toLocaleLowerCase().includes(query);
	});
});
const missingSelectedGroupCount = computed(() =>
	form.selectedGroupIds.length - selectedGroups.value.length);
const filteredSelectedGroups = computed(() => {
	const query = selectedItemSearch.value.trim().toLocaleLowerCase();
	if (!query) {
		return selectedGroups.value;
	}

	return selectedGroups.value.filter((group) => {
		const subtitle = mediaGroupSubtitle(selectedLibraryType.value, group) || group.kind;
		return `${group.title} ${subtitle}`.toLocaleLowerCase().includes(query);
	});
});
const sourceLibraries = computed(() =>
	form.sourceType === 'group' || form.sourceType === 'group-collection'
		? librariesStore.libraries.filter((library) => library.typeKey === 'shows')
		: librariesStore.libraries);
const sourceTypeLabel = computed(() => ({
	'library-query': 'Library query',
	collection: 'Specific media items',
	'group-collection': 'Specific media groups',
	group: 'Show or season',
	item: 'Exact item',
})[form.sourceType]);
const sourceLibraryLabel = computed(() => {
	if (form.sourceType === 'item') {
		return 'Defined by the exact item';
	}

	if (form.sourceType === 'group') {
		return 'Defined by the show or season';
	}

	return librariesStore.libraries.find((library) => library.id === form.libraryId)?.name
		?? 'Missing library';
});
const selectedLibraryType = computed(
	() =>
		librariesStore.libraries.find((library) => library.id === form.libraryId)?.typeKey ?? 'other',
);
const libraryQueryKinds = computed(() => {
	const type = librariesStore.libraries.find((library) => library.id === form.libraryId)?.typeKey;
	if (type === 'movies') {
		return ['movie'];
	}

	if (type === 'shows') {
		return ['episode'];
	}

	if (type === 'music-videos') {
		return ['music-video'];
	}

	return ['other'];
});
const form = reactive({
	subtitlePreferences: {} as SubtitlePreferences,
	audioPreferences: {} as AudioPreferences,
	name: '',
	type: 'content' as 'content' | 'sequence' | 'similarity' | 'theme',
	sourceProgramId: '',
	theme: '',
	variety: DEFAULT_SIMILARITY_VARIETY,
	quantity: DEFAULT_SIMILARITY_QUANTITY,
	softPreferences: '',
	exclusionText: '',
	exclusionStrictness: DEFAULT_SEMANTIC_EXCLUSION_STRICTNESS,
	sourceType: 'library-query' as
    'library-query' | 'collection' | 'item' | 'group' | 'group-collection',
	libraryId: '',
	sourceId: '',
	includeDescendants: true,
	kinds: [] as string[],
	filter: emptyCatalogProgramItemFilter(),
	querySort: { type: 'name', direction: 'asc' } as {
		type: 'name' | 'date-added' | 'release-date';
		direction: 'asc' | 'desc';
	},
	queryItemLimit: null as number | null,
	selectedItemIds: [] as string[],
	selectedItemSort: 'date-added' as 'date-added' | 'name' | 'release-date' | 'manual',
	selectedItemSortDirection: 'asc' as 'asc' | 'desc',
	manualItemIds: [] as string[],
	selectedGroupIds: [] as string[],
	strategy: 'sequential' as 'sequential' | 'shuffle' | 'random' | 'weighted-random',
	seed: '',
	sequenceOrdering: 'ordered' as SequenceOrdering['type'],
	repeat: true,
	entries: [] as Array<{ id: string; programId: string; count: number }>,
});
const originalSnapshot = ref(JSON.stringify(form));
const previewProgramNames = computed(() => new Map(programs.value.map(program => [program.id, program.name])));
const isDirty = computed(() => JSON.stringify(form) !== originalSnapshot.value);

/** Initialize the form from an existing program or safe defaults for a new content rule. */
function resetForm(program?: SchedulingProgram): void {
	selectionDrawerOpen.value = false;
	selectedItemSearch.value = '';
	form.name = program?.name ?? '';
	form.audioPreferences = cloneContractValue(program?.config.audioPreferences ?? {});
	form.subtitlePreferences = cloneContractValue(program?.config.subtitlePreferences ?? {});
	form.type = program?.config.type ?? 'content';
	form.theme = program?.config.type === 'theme' ? program.config.theme : '';
	form.sourceProgramId = program?.config.type === 'similarity' ? program.config.sourceProgramId : '';
	form.variety = (program?.config.type === 'similarity' || program?.config.type === 'theme') ? program.config.variety : DEFAULT_SIMILARITY_VARIETY;
	form.quantity = (program?.config.type === 'similarity' || program?.config.type === 'theme') ? program.config.quantity : DEFAULT_SIMILARITY_QUANTITY;
	form.softPreferences = (program?.config.type === 'similarity' || program?.config.type === 'theme') ? program.config.softPreferences ?? '' : '';
	form.exclusionText = (program?.config.type === 'similarity' || program?.config.type === 'theme') ? (program.config.hardExclusions ?? []).join(', ') : '';
	form.exclusionStrictness = (program?.config.type === 'similarity' || program?.config.type === 'theme') ? program.config.exclusionStrictness ?? DEFAULT_SEMANTIC_EXCLUSION_STRICTNESS : DEFAULT_SEMANTIC_EXCLUSION_STRICTNESS;
	form.sourceType = 'library-query';
	form.libraryId = program?.config.type === 'theme' ? program.config.libraryId : librariesStore.libraries[0]?.id ?? '';
	form.sourceId = '';
	form.includeDescendants = true;
	form.kinds = [];
	form.filter = program?.config.type === 'theme' || program?.config.type === 'similarity' ? catalogProgramItemFilterSchema.parse(program.config.filter ?? {}) : emptyCatalogProgramItemFilter();
	form.querySort = { type: 'name', direction: 'asc' };
	form.queryItemLimit = null;
	form.selectedItemIds = [];
	form.selectedItemSort = 'date-added';
	form.selectedItemSortDirection = 'asc';
	form.manualItemIds = [];
	form.selectedGroupIds = [];
	form.strategy = 'sequential';
	form.seed = '';
	form.sequenceOrdering = 'ordered';
	form.repeat = true;
	form.entries = [];
	selectedItemOrdering.reset();
	selectedSourceLabel.value = '';
	selectedItems.value = [];
	selectedItemsLoaded.value = false;
	selectedGroups.value = [];
	selectedGroupsLoaded.value = false;
	if (program?.config.type === 'content') {
		const source = program.config.source;
		form.sourceType = source.type;
		switch (source.type) {
			case 'library-query':
				form.libraryId = source.libraryId;
				form.kinds = [...source.kinds];
				form.filter = catalogProgramItemFilterSchema.parse(source);
				form.querySort = { ...(source.sort ?? { type: 'name', direction: 'asc' }) };
				form.queryItemLimit = source.itemLimit ?? null;
				break;
			case 'collection':
				form.libraryId = source.libraryId;
				form.selectedItemIds = [...source.itemIds];
				selectedItemOrdering.reset(source);
				form.selectedItemSort = source.sort.type;
				form.selectedItemSortDirection = source.sort.type === 'manual'
					? 'asc'
					: source.sort.direction;
				form.manualItemIds = source.sort.type === 'manual' ? [...source.sort.itemIds] : [];
				break;
			case 'item':
				form.sourceId = source.itemId;
				selectedSourceLabel.value = statuses.value.get(program.id)?.sourceLabel ?? 'Selected item';
				break;
			case 'group':
				form.sourceId = source.groupId;
				form.includeDescendants = source.includeDescendants;
				selectedSourceLabel.value = statuses.value.get(program.id)?.sourceLabel ?? 'Selected group';
				break;
			case 'group-collection':
				form.libraryId = source.libraryId;
				form.selectedGroupIds = [...source.groupIds];
				break;
		}
		form.strategy = program.config.strategy.type;
		form.seed = 'seed' in program.config.strategy ? program.config.strategy.seed : '';
	}
	if (program?.config.type === 'sequence') {
		form.sequenceOrdering = program.config.ordering?.type ?? 'ordered';
		form.seed = program.config.ordering && 'seed' in program.config.ordering ? program.config.ordering.seed : '';
		form.repeat = program.config.repeat;
		form.entries = cloneContractValue(program.config.entries);
	}
	if (!program) {
		form.kinds = [...libraryQueryKinds.value];
	}
	sourceParentId.value = undefined;
	sourcePage.value = 1;
	sourceSearch.value = '';
	originalSnapshot.value = JSON.stringify(form);
}

/** Load genre facets or paged source choices while discarding superseded responses. */
async function loadSourceOptions(): Promise<void> {
	const sequence = ++sourceLoadSequence;
	if (!form.libraryId) {
		sourceEntries.value = [];
		genres.value = [];
		sourceLoading.value = false;
		sourceLoaded.value = true;
		return;
	}

	sourceLoading.value = true;
	sourceLoaded.value = false;
	try {
		if (form.type === 'theme' || form.sourceType === 'library-query') {
			const facets = await api.mediaGenres(form.libraryId);
			if (sequence !== sourceLoadSequence) {
				return;
			}

			sourceEntries.value = [];
			sourcePage.value = 1;
			sourceTotalPages.value = 1;
			genres.value = facets;
			sourceLoaded.value = true;
			return;
		}

		const browse = await api.mediaSourceOptions(form.libraryId, {
			target: form.sourceType === 'group' || form.sourceType === 'group-collection'
				? 'groups'
				: 'items',
			...(sourceParentId.value ? { parentId: sourceParentId.value } : {}),
			page: sourcePage.value,
			pageSize: 20,
			search: sourceSearch.value,
		});
		if (sequence !== sourceLoadSequence) {
			return;
		}

		sourceEntries.value = browse.entries;
		sourcePage.value = browse.pagination.page;
		sourceTotalPages.value = browse.pagination.totalPages;
		genres.value = [];
		sourceLoaded.value = true;
	}
	catch (cause) {
		if (sequence === sourceLoadSequence) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === sourceLoadSequence) {
			sourceLoading.value = false;
		}
	}
}

/** Resolve selected item identifiers into review cards while discarding superseded responses. */
async function loadSelectedItems(): Promise<void> {
	const sequence = ++selectedItemsLoadSequence;
	if (form.sourceType !== 'collection' || !form.libraryId || form.selectedItemIds.length === 0) {
		selectedItems.value = [];
		selectedItemsLoading.value = false;
		selectedItemsLoaded.value = true;
		return;
	}

	selectedItemsLoading.value = true;
	selectedItemsLoaded.value = false;
	try {
		const requestedIds = form.selectedItemSort === 'manual'
			? form.manualItemIds
			: selectedItemOrdering.additionOrder.value.itemIds;
		const items = await api.mediaSelection(form.libraryId, requestedIds);
		if (sequence === selectedItemsLoadSequence) {
			selectedItems.value = items;
			selectedItemsLoaded.value = true;
		}
	}
	catch (cause) {
		if (sequence === selectedItemsLoadSequence) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === selectedItemsLoadSequence) {
			selectedItemsLoading.value = false;
		}
	}
}

/** Resolve selected group identifiers into review cards while discarding superseded responses. */
async function loadSelectedGroups(): Promise<void> {
	const sequence = ++selectedGroupsLoadSequence;
	if (
		form.sourceType !== 'group-collection'
		|| !form.libraryId
		|| form.selectedGroupIds.length === 0
	) {
		selectedGroups.value = [];
		selectedGroupsLoading.value = false;
		selectedGroupsLoaded.value = true;
		return;
	}

	selectedGroupsLoading.value = true;
	selectedGroupsLoaded.value = false;
	try {
		const groups = await api.mediaGroupSelection(form.libraryId, form.selectedGroupIds);
		if (sequence === selectedGroupsLoadSequence) {
			selectedGroups.value = groups;
			selectedGroupsLoaded.value = true;
		}
	}
	catch (cause) {
		if (sequence === selectedGroupsLoadSequence) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === selectedGroupsLoadSequence) {
			selectedGroupsLoading.value = false;
		}
	}
}

/** Apply a single item or group chosen from the source browser. */
function selectSource(entry: MediaSourcePickerEntry): void {
	if (form.sourceType === 'item' && entry.item) {
		form.sourceId = entry.item.id;
		selectedSourceLabel.value = entry.item.title;
	}
	if (form.sourceType === 'group' && entry.group) {
		form.sourceId = entry.group.id;
		selectedSourceLabel.value = entry.group.title;
	}
}

/** Open a show group in the source picker hierarchy. */
function browseGroup(entry: MediaSourcePickerEntry): void {
	if (entry.group) {
		sourceParentId.value = entry.group.id;
		sourcePage.value = 1;
		void loadSourceOptions();
	}
}

/** Add or remove an explicit media item while enforcing the collection size limit. */
function toggleSelectedItem(item: MediaItem): void {
	if (selectedIdSet.value.has(item.id)) {
		form.selectedItemIds = form.selectedItemIds.filter((id) => id !== item.id);
		form.manualItemIds = form.manualItemIds.filter((id) => id !== item.id);
		selectedItems.value = selectedItems.value.filter((selected) => selected.id !== item.id);
		return;
	}

	if (form.selectedItemIds.length >= channelsStore.maxExplicitMediaItems) {
		error.value = `A collection can contain at most ${channelsStore.maxExplicitMediaItems} items.`;
		return;
	}

	form.selectedItemIds.push(item.id);
	if (form.selectedItemSort === 'manual') {
		form.manualItemIds.push(item.id);
	}
	selectedItems.value.push(item);
	selectedItemsLoaded.value = true;
}

/** Add or remove a media group while enforcing the group-selection limit. */
function toggleSelectedGroup(group: MediaGroup): void {
	if (selectedGroupIdSet.value.has(group.id)) {
		form.selectedGroupIds = form.selectedGroupIds.filter((id) => id !== group.id);
		selectedGroups.value = selectedGroups.value.filter((selected) => selected.id !== group.id);
		return;
	}

	if (form.selectedGroupIds.length >= MAX_EXPLICIT_MEDIA_GROUPS) {
		error.value = `A program can contain at most ${MAX_EXPLICIT_MEDIA_GROUPS} selected media groups.`;
		return;
	}

	form.selectedGroupIds.push(group.id);
	selectedGroups.value.push(group);
	selectedGroupsLoaded.value = true;
}

/** Remove one explicit item from both the request identifiers and review cards. */
function removeSelectedItem(id: string): void {
	form.selectedItemIds = form.selectedItemIds.filter((candidate) => candidate !== id);
	form.manualItemIds = form.manualItemIds.filter((candidate) => candidate !== id);
	selectedItems.value = selectedItems.value.filter((item) => item.id !== id);
}

/** Change selected-media ordering and freeze the current display when entering Manual. */
function changeSelectedItemSort(value: 'date-added' | 'name' | 'release-date' | 'manual'): void {
	if (value === 'manual') {
		form.manualItemIds = manualOrderFromDisplay(
			form.selectedItemIds,
			selectedItemOrdering.orderedItems.value,
		);
		selectedItems.value = [...selectedItemOrdering.orderedItems.value];
	}
	else if (form.selectedItemSort === 'manual') {
		selectedItems.value = itemsInReferenceOrder(form.selectedItemIds, selectedItems.value);
		form.manualItemIds = [];
	}

	form.selectedItemSort = value;
}

/** Persist a complete visible Manual ordering while retaining missing references at the end. */
function reorderSelectedItems(itemIds: string[]): void {
	if (form.selectedItemSort !== 'manual' || selectedItemSearch.value.trim()) {
		return;
	}

	form.manualItemIds = mergeVisibleManualOrder(form.manualItemIds, itemIds);
	selectedItems.value = itemsInReferenceOrder(itemIds, selectedItems.value);
}

/** Move one visible Manual item by one position for keyboard-accessible ordering. */
function moveSelectedItem(id: string, offset: -1 | 1): void {
	const ids = selectedItemOrdering.orderedItems.value.map((item) => item.id);
	const index = ids.indexOf(id);
	const target = index + offset;
	if (index < 0 || target < 0 || target >= ids.length) {
		return;
	}

	const [itemId] = ids.splice(index, 1);
	ids.splice(target, 0, itemId!);
	reorderSelectedItems(ids);
}

/** Remove one selected group from both the request identifiers and review cards. */
function removeSelectedGroup(id: string): void {
	form.selectedGroupIds = form.selectedGroupIds.filter((candidate) => candidate !== id);
	selectedGroups.value = selectedGroups.value.filter((group) => group.id !== id);
}

/** Open the selection review drawer when the current source has selected entries. */
async function openSelectionDrawer(): Promise<void> {
	if (
		(form.sourceType === 'collection' && form.selectedItemIds.length === 0)
		|| (form.sourceType === 'group-collection' && form.selectedGroupIds.length === 0)
	) {
		return;
	}

	selectionDrawerOpen.value = true;
}

/** Close the selection review, clear its search, and restore focus to its trigger. */
async function closeSelectionDrawer(): Promise<void> {
	selectionDrawerOpen.value = false;
	selectedItemSearch.value = '';
	await nextTick();
	selectionReviewButton.value?.focus();
}

/** Confirm and clear every explicit item or group from the current source. */
function clearSelectedItems(): void {
	const groups = form.sourceType === 'group-collection';
	if (groups) {
		form.selectedGroupIds = [];
		selectedGroups.value = [];
		selectedGroupsLoaded.value = true;
	}
	else {
		form.selectedItemIds = [];
		form.manualItemIds = [];
		selectedItems.value = [];
		selectedItemsLoaded.value = true;
	}
	selectedItemSearch.value = '';
}


/** Clear selections and filters that cannot carry across a source-library change. */
function changeSourceLibrary(): void {
	selectionDrawerOpen.value = false;
	selectedItemSearch.value = '';
	form.sourceId = '';
	selectedSourceLabel.value = '';
	if (form.sourceType === 'collection') {
		form.selectedItemIds = [];
		form.manualItemIds = [];
		selectedItemOrdering.reset();
		selectedItems.value = [];
		selectedItemsLoaded.value = true;
	}
	if (form.sourceType === 'group-collection') {
		form.selectedGroupIds = [];
		selectedGroups.value = [];
		selectedGroupsLoaded.value = true;
	}
	sourceParentId.value = undefined;
	sourcePage.value = 1;
	sourceSearch.value = '';
	if (form.sourceType === 'library-query') {
		form.kinds = [...libraryQueryKinds.value];
		form.filter = emptyCatalogProgramItemFilter();
		form.querySort = { type: 'name', direction: 'asc' };
		form.queryItemLimit = null;
	}
}

/** Reset source-specific state and load choices valid for the newly selected source type. */
async function changeSourceType(): Promise<void> {
	selectionDrawerOpen.value = false;
	selectedItemSearch.value = '';
	const previousLibraryId = form.libraryId;
	form.sourceId = '';
	selectedSourceLabel.value = '';
	form.selectedItemIds = [];
	form.manualItemIds = [];
	selectedItemOrdering.reset();
	form.selectedGroupIds = [];
	selectedItems.value = [];
	selectedItemsLoaded.value = true;
	selectedGroups.value = [];
	selectedGroupsLoaded.value = true;
	sourceParentId.value = undefined;
	sourcePage.value = 1;
	sourceSearch.value = '';
	await nextTick();
	if (!sourceLibraries.value.some((library) => library.id === form.libraryId)) {
		form.libraryId = sourceLibraries.value[0]?.id ?? '';
	}
	if (form.sourceType === 'library-query') {
		form.kinds = [...libraryQueryKinds.value];
		form.filter = emptyCatalogProgramItemFilter();
		form.querySort = { type: 'name', direction: 'asc' };
		form.queryItemLimit = null;
	}
	if (previousLibraryId === form.libraryId) {
		void loadSourceOptions();
	}
}

/** Restart source lookup from the first page using current search text. */
function searchSources(): void {
	sourcePage.value = 1;
	void loadSourceOptions();
}

/** Clamp and load a requested page of source choices. */
function changeSourcePage(page: number): void {
	sourcePage.value = Math.min(Math.max(page, 1), sourceTotalPages.value);
	void loadSourceOptions();
}

/** Serialize only settings used by the selected sequence ordering mode. */
function sequenceOrdering(): SequenceOrdering {
	return form.sequenceOrdering === 'shuffled-blocks' || form.sequenceOrdering === 'shuffled-allocations'
		? { type: form.sequenceOrdering, seed: form.seed }
		: { type: form.sequenceOrdering };
}

/** Append a sequence entry using the first program other than the one being edited. */
function addSequenceEntry(): void {
	const candidate = programs.value.find((program) => program.id !== editingId.value);
	if (candidate) {
		form.entries.push({ id: randomUuid(), programId: candidate.id, count: 1 });
	}
}

/** Move one sequence entry by a bounded offset while preserving authored order. */
function moveEntry(index: number, offset: number): void {
	const target = index + offset;
	if (target < 0 || target >= form.entries.length) {
		return;
	}

	const [entry] = form.entries.splice(index, 1);
	form.entries.splice(target, 0, entry!);
}

/** Build the validated request body from the current editor form. */
function payload(): ProgramCreate {
	if (form.type === 'similarity' || form.type === 'theme') {
		return { name: form.name, config: { ...(form.type === 'theme' ? { type: 'theme', libraryId: form.libraryId, theme: form.theme, filter: form.filter } as const : { type: 'similarity', sourceProgramId: form.sourceProgramId, filter: form.filter } as const),
			variety: form.variety, quantity: form.quantity, softPreferences: form.softPreferences,
			hardExclusions: form.exclusionText.split(',').map((text) => text.trim()).filter(Boolean), exclusionStrictness: form.exclusionStrictness, subtitlePreferences: form.subtitlePreferences,
			audioPreferences: form.audioPreferences } };
	}
	if (form.type === 'sequence') {
		return {
			name: form.name,
			config: { type: 'sequence', ordering: sequenceOrdering(), entries: form.entries, repeat: form.repeat, subtitlePreferences: form.subtitlePreferences, audioPreferences: form.audioPreferences },
		};
	}

	const strategy
		= form.strategy === 'sequential'
			? ({ type: 'sequential' } as const)
			: ({ type: form.strategy, seed: form.seed } as const);
	if (form.sourceType === 'collection' && form.selectedItemIds.length === 0) {
		throw new Error('Select at least one media item.');
	}

	if (form.sourceType === 'group-collection' && form.selectedGroupIds.length === 0) {
		throw new Error('Select at least one media group.');
	}

	const source
		= form.sourceType === 'item'
			? ({ type: 'item', itemId: form.sourceId } as const)
			: form.sourceType === 'group'
				? ({
					type: 'group',
					groupId: form.sourceId,
					includeDescendants: form.includeDescendants,
				} as const)
				: form.sourceType === 'group-collection'
					? ({
						type: 'group-collection',
						libraryId: form.libraryId,
						groupIds: form.selectedGroupIds,
					} as const)
					: form.sourceType === 'collection'
						? ({
							type: 'collection',
							libraryId: form.libraryId,
							itemIds: selectedItemOrdering.additionOrder.value.itemIds,
							sort: selectedItemSort.value,
						} as const)
						: ({
							type: 'library-query',
							libraryId: form.libraryId,
							kinds: form.kinds,
							...form.filter,
							sort: form.querySort,
							itemLimit: form.queryItemLimit,
						} as const);
	return { name: form.name, config: { type: 'content', source, strategy, subtitlePreferences: form.subtitlePreferences, audioPreferences: form.audioPreferences } };
}
const { deleting, resetProgram, deleteProgram } = useProgramResourceActions({
	program: () => programs.value.find((candidate) => candidate.id === editingId.value),
	embedded: () => props.embedded,
	saving: () => saving.value,
	resetDraft: (program) => {
		resetForm(program);
		error.value = '';
	},
	reloadDraft: async () => await Promise.all([
		loadSourceOptions(), loadSelectedItems(), loadSelectedGroups(),
	]).then(() => undefined),
	onDeleted: async () => {
		await scheduling.load();
		await leaveEditor();
	},
	onError: (cause) => error.value = errorMessage(cause),
});

const programSaveDisabled = computed(() =>
	saving.value || deleting.value || !isProgramDraftValid(payload)
	|| (Boolean(editingId.value) && !isDirty.value));

/** Validate and save the program draft. */
async function save(stayOnPage = false): Promise<boolean> {
	if (programSaveDisabled.value) {
		return false;
	}

	saving.value = true;
	error.value = '';
	try {
		const operation = editingId.value
			? api.updateProgram(editingId.value, payload())
			: api.createProgram(payload());
		const saved = await operation;
		await scheduling.load();
		originalSnapshot.value = JSON.stringify(form);
		if (stayOnPage) {
			return true;
		}
		if (props.embedded) {
			emit('saved', saved.id);
		}
		else {
			await leaveEditor();
		}
		return true;
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		saving.value = false;
	}
	return false;
}

/** Navigate after an explicit save or discard without prompting for the same draft twice. */
async function leaveEditor(): Promise<void> {
	allowRouteLeave = true;
	try {
		await router.push({ path: '/schedules/programs', query: route.query });
	}
	finally {
		allowRouteLeave = false;
	}
}

/** Save, discard, or retain an edited program before closing its editor. */
async function closeEditor(): Promise<void> {
	await closeUnsavedEditor({
		blocked: saving.value || deleting.value,
		dirty: isDirty.value,
		key: `unsaved-program:${editingId.value ?? 'new'}`,
		message: 'Save this program before closing?',
		save: () => save(),
		discard: () => props.embedded ? emit('close') : leaveEditor(),
	});
}

/** Protect the current draft before navigating to another resource or page. */
async function confirmRouteLeave(): Promise<boolean> {
	if (allowRouteLeave || !editorOpen.value) {
		return true;
	}
	let proceed = false;
	await closeUnsavedEditor({
		blocked: saving.value || deleting.value,
		dirty: isDirty.value,
		key: `unsaved-program:${editingId.value ?? 'new'}`,
		message: 'Save this program before leaving?',
		save: async () => {
			proceed = await save(true);
		},
		discard: () => {
			proceed = true;
		},
	});
	return proceed;
}
onBeforeRouteLeave(confirmRouteLeave);
onBeforeRouteUpdate(async (to, from) => to.params.id === from.params.id || await confirmRouteLeave());

watch(
	() => [route.params.id, props.programId],
	() => {
		const program = programs.value.find((candidate) => candidate.id === editingId.value);
		resetForm(program);
		void Promise.all([loadSourceOptions(), loadSelectedItems(), loadSelectedGroups()]);
	},
);
watch(() => [form.libraryId, form.type], () => void loadSourceOptions());
onMounted(async () => {
	unsubscribeLiveEvents = subscribeToSelectedMediaRefresh(
		() => form.libraryId,
		() => form.type === 'theme' || form.sourceType === 'collection' || form.sourceType === 'library-query',
		() => {
			if (form.type !== 'theme' && form.sourceType === 'collection') {
				void loadSelectedItems();
			}
			else {
				queryPreviewRevision.value += 1;
				void loadSourceOptions();
			}
		},
	);
	try {
		await Promise.all([
			scheduling.load(),
			librariesStore.load(),
			channelsStore.capabilitiesLoaded
				? Promise.resolve()
				: channelsStore.loadCapabilities(),
		]);
		resetForm(programs.value.find((program) => program.id === editingId.value));
		await Promise.all([loadSourceOptions(), loadSelectedItems(), loadSelectedGroups()]);
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		initialLoading.value = false;
	}
});
onBeforeUnmount(() => {
	unsubscribeLiveEvents?.();
});
useDraftProtection(() => editorOpen.value && isDirty.value);
</script>

<template>
	<section>
		<div
			v-if="editorOpen"
			class="moirai-dialog-backdrop"

			:class="{ 'nested-modal-backdrop': embedded }"
			@click.self="closeEditor"
		>
			<form
				v-modal-focus="{ escape: closeEditor }"
				class="moirai-dialog schedule-editor-modal" role="dialog"
				aria-modal="true"
				:aria-label="initialLoading ? 'Program editor' : undefined"
				:aria-labelledby="initialLoading ? undefined : 'program-editor-title'"
				@submit.prevent="save()"
			>
				<ResourceEditorHeader close-label="Close program editor" :disabled="saving || deleting" @close="closeEditor">
					<p class="eyebrow">
						{{ initialLoading ? 'Program editor' : editingId ? `Edit ${form.type} rule` : 'New program' }}
					</p>
					<div class="resource-editor-title-with-help"><h2 id="program-editor-title">
						{{ initialLoading ? 'Loading Program' : editingId ? 'Edit Program' : 'Create Program' }}
					</h2><PageHelpButton label="Programs" topic-id="scheduling.programs" /></div>
					<p v-if="!initialLoading">
						{{
							form.type === 'content'
								? 'Define what content can play and how it should be selected.'
								: form.type === 'theme' ? 'Find media matching a theme in a target library.' : form.type === 'similarity' ? 'Select related media from a Specific media items Program.' : 'Arrange reusable programs in a custom repeating order.'
						}}
					</p>
				</ResourceEditorHeader>
				<LoadingState v-if="initialLoading" label="Loading program editor…" />
				<div v-if="!initialLoading" class="program-editor-scroll">
					<ResourceUsage kind="program" :resource-id="editingId ?? undefined"><div class="program-editor-layout">
						<ProgramTypeRail v-model="form.type" :disabled="Boolean(editingId)" />
						<div class="program-editor-main">
							<p v-if="error" class="notice error">{{ error }}</p>
							<label class="program-name-field resource-primary-field">
								<span>Name</span>
								<small>A descriptive name for this {{ form.type }} rule.</small>
								<input
									v-model="form.name"
									autocapitalize="words"
									required
									:placeholder="
										form.type === 'content' ? 'e.g. Primetime Movies' : 'e.g. Evening Lineup'
									"
								/>
							</label>

							<template v-if="form.type === 'content'">
								<section class="program-editor-section">
									<div class="program-section-heading">
										<span>1</span>
										<div class="program-section-heading-copy">
											<strong>Content source</strong>
											<p class="program-section-description">Choose the source of eligible media.</p>
										</div>
									</div>
									<div class="program-source-panel">
										<div class="form-grid">
											<div v-if="editingId" class="program-fixed-field">
												<span>Source type</span>
												<strong>{{ sourceTypeLabel }}</strong>
											</div>
											<label v-else
											><span>Source type</span
											><select
												v-model="form.sourceType"
												aria-label="Source type"
												@change="changeSourceType"
											>
												<option value="library-query">Library query</option>
												<option value="collection">Specific media items</option>
												<option value="group-collection">Specific media groups</option>
												<option v-if="form.sourceType === 'group'" value="group">
													Show or season (legacy)
												</option>
												<option v-if="form.sourceType === 'item'" value="item">
													Exact item (legacy)
												</option>
											</select></label
											>
											<div v-if="editingId" class="program-fixed-field">
												<span>Library</span>
												<strong>{{ sourceLibraryLabel }}</strong>
											</div>
											<label v-else
											><span>Library</span
											><select
												v-model="form.libraryId"
												aria-label="Library"
												@change="changeSourceLibrary"
											>
												<option v-if="sourceLibraries.length === 0" value="" disabled>
													No compatible libraries
												</option>
												<option
													v-for="library in sourceLibraries"
													:key="library.id"
													:value="library.id"
												>
													{{ library.name }}
												</option>
											</select></label
											>
										</div>
										<template v-if="form.sourceType === 'library-query'">
											<ProgramLibraryQuery
												v-model="form.filter"
												v-model:sort="form.querySort"
												v-model:item-limit="form.queryItemLimit"
												:library-id="form.libraryId"
												:library-type="selectedLibraryType"
												:genres="genres"
												:loading="sourceLoading"
												:loaded="sourceLoaded"
												:refresh-revision="queryPreviewRevision"
											/>
										</template>
										<template v-else>
											<p
												v-if="
													form.sourceType !== 'collection' && form.sourceType !== 'group-collection'
												"
												class="selected-source"
											>
												Selected: {{ selectedSourceLabel || 'None' }}
											</p>
											<div v-else class="selected-collection-summary">
												<div class="selected-collection-copy">
													<strong
													>{{
														form.sourceType === 'group-collection'
															? form.selectedGroupIds.length
															: form.selectedItemIds.length
													}}
														selected</strong
													>
													<small
														v-if="
															form.sourceType === 'group-collection'
																? selectedGroupsLoading && !selectedGroupsLoaded
																: selectedItemsLoading && !selectedItemsLoaded
														"
													>Loading selection…</small
													>
													<small
														v-else-if="
															form.sourceType === 'group-collection'
																? missingSelectedGroupCount > 0
																: missingSelectedCount > 0
														"
														class="availability-warning"
													>
														{{
															form.sourceType === 'group-collection'
																? missingSelectedGroupCount
																: missingSelectedCount
														}}
														no longer indexed · references preserved
													</small>
													<small v-else
													>Maximum
														{{
															form.sourceType === 'group-collection'
																? MAX_EXPLICIT_MEDIA_GROUPS
																: channelsStore.maxExplicitMediaItems
														}}</small
													>
												</div>
												<div class="selected-collection-actions">
													<div
														v-if="
															form.sourceType === 'group-collection'
																? selectedGroups.length
																: selectedItems.length
														"
														class="selected-poster-stack"
														aria-hidden="true"
													>
														<span
															v-for="selection in form.sourceType === 'group-collection'
																? selectedGroups.slice(0, 4)
																: selectedItems.slice(0, 4)"
															:key="selection.id"
														>
															<span class="source-artwork-placeholder"><Asterisk :size="14" /></span>
															<img
																v-if="selection.artworkUrl"
																:src="artworkVariantUrl(selection.artworkUrl, 'thumb')"
																:srcset="artworkSrcset(selection.artworkUrl, 'thumb')"
																alt=""
																loading="eager"
																decoding="async"
																@error="hideBrokenImage"
															/>
														</span>
														<b
															v-if="
																(form.sourceType === 'group-collection'
																	? form.selectedGroupIds.length
																	: form.selectedItemIds.length) > 4
															"
														>+{{
															(form.sourceType === 'group-collection'
																? form.selectedGroupIds.length
																: form.selectedItemIds.length) - 4
														}}</b
														>
													</div>
													<button
														ref="selectionReviewButton"
														type="button"
														class="toolbar-button selected-review-button"
														:disabled="
															form.sourceType === 'group-collection'
																? form.selectedGroupIds.length === 0
																: form.selectedItemIds.length === 0
														"
														@click="openSelectionDrawer"
													>
														Review Selection
													</button>
												</div>
											</div>
											<label v-if="form.sourceType === 'group'" class="check-row"
											><input v-model="form.includeDescendants" type="checkbox" />Include
												descendants</label
											>
											<ProgramSourceBrowser
												v-model:open="sourceBrowserOpen" v-model:search="sourceSearch"
												:source-type="form.sourceType" :library-type="selectedLibraryType"
												:source-entries="sourceEntries" :source-loading="sourceLoading" :source-loaded="sourceLoaded"
												:source-parent-id="sourceParentId" :source-page="sourcePage" :source-total-pages="sourceTotalPages"
												:selected-id-set="selectedIdSet" :selected-group-id-set="selectedGroupIdSet"
												@search="searchSources" @browse="browseGroup" @select="selectSource"
												@toggle-item="toggleSelectedItem" @toggle-group="toggleSelectedGroup" @page="changeSourcePage"
												@root="sourceParentId = undefined; sourcePage = 1; loadSourceOptions();"
											/>
										</template>
									</div>
								</section>
								<SelectionStrategyEditor v-model="form.strategy" v-model:seed="form.seed" />
							</template>

							<SimilarityProgramEditor v-else-if="form.type === 'similarity' || form.type === 'theme'" v-model:filter="form.filter" v-model:theme="form.theme" v-model:library-id="form.libraryId" v-model:source-program-id="form.sourceProgramId" v-model:variety="form.variety" v-model:quantity="form.quantity" v-model:soft-preferences="form.softPreferences" v-model:exclusion-text="form.exclusionText" v-model:exclusion-strictness="form.exclusionStrictness" :genres="genres" :filters-loading="sourceLoading" :filters-loaded="sourceLoaded" :type="form.type" :libraries="librariesStore.libraries" :read-only-source="Boolean(editingId)" :programs="programs" :status="statuses.get(editingId ?? '')" />
							<SequenceProgramEditor
								v-else
								v-model:entries="form.entries"
								v-model:repeat="form.repeat"
								:programs="programs"
								:editing-id="editingId"
								@add="addSequenceEntry"
								@move="moveEntry"
								@remove="form.entries.splice($event, 1)"
							/>
							<SequenceOrderingEditor v-if="form.type === 'sequence'" v-model="form.sequenceOrdering" v-model:seed="form.seed" />
							<SequenceGuidePreview v-if="form.type === 'sequence'" :config="payload().config" :program-id="editingId ?? undefined" :program-names="previewProgramNames" />
							<FormDisclosure v-model:open="subtitlesOpen" class="program-subtitle-disclosure">
								<template #summary>
									<div class="program-section-heading">
										<span>{{ form.type === 'content' || form.type === 'sequence' ? 3 : 2 }}</span>
										<div class="program-section-heading-copy">
											<strong>Audio and subtitles — optional</strong>
											<p class="program-section-description">Override inherited audio and subtitle settings for this program.</p>
										</div>
									</div>
									<ChevronDown class="form-disclosure-chevron" :size="22" aria-hidden="true" />
								</template>
								<AudioPreferencesEditor v-model="form.audioPreferences" inherit unframed />
								<SubtitlePreferencesEditor v-model="form.subtitlePreferences" inherit unframed />
							</FormDisclosure>
						</div>
					</div></ResourceUsage>
				</div>
				<ResourceEditorActionBar
					v-if="!initialLoading"
					resource-type="Program"
					:show-delete="!embedded && Boolean(editingId)" :busy="saving || deleting"
					:deleting="deleting" :reset-disabled="!isDirty"
					:save-disabled="programSaveDisabled" :saving="saving"
					save-submits
					@delete="deleteProgram" @reset="resetProgram"
				/>
			</form>
		</div>
		<MediaSelectionDrawer
			v-if="selectionDrawerOpen"
			:selecting-groups="selectingGroups"
			:selection-count="selectionCount"
			:selection-limit="selectionLimit"
			:loading="selectingGroups ? selectedGroupsLoading : selectedItemsLoading"
			:loaded="selectingGroups ? selectedGroupsLoaded : selectedItemsLoaded"
			:missing-item-count="missingSelectedCount"
			:missing-group-count="missingSelectedGroupCount"
			:items="filteredSelectedItems"
			:groups="filteredSelectedGroups"
			:selected-item-count="selectedItems.length"
			:selected-group-count="selectedGroups.length"
			:item-reference-count="form.selectedItemIds.length"
			:group-reference-count="form.selectedGroupIds.length"
			:library-type="selectedLibraryType"
			:search="selectedItemSearch"
			:sort="selectedItemSort"
			@update:search="selectedItemSearch = $event"
			@update:sort-type="changeSelectedItemSort"
			@update:sort-direction="form.selectedItemSortDirection = $event"
			@reorder-items="reorderSelectedItems"
			@move-item="moveSelectedItem"
			@close="closeSelectionDrawer"
			@clear="clearSelectedItems"
			@remove-item="removeSelectedItem"
			@remove-group="removeSelectedGroup"
		/>
	</section>
</template>
