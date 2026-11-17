<script setup lang="ts">
import type { GraphicsAssignment } from '@moirai/shared';
import GraphicsAssignmentEditor from '../graphics/GraphicsAssignmentEditor.vue';
import ProgramAiSource from './ProgramAiSource.vue';
import { useProgramDraft, type SequenceDraftEntry } from './program-draft';
import { useAuthenticationStore } from '../../stores/authentication';
import SequenceGuidePreview from './SequenceGuidePreview.vue';
import { AI_DEFAULT_RESULT_COUNT, type AiResultCount, type SequenceOrdering } from '@moirai/shared';
import SequenceOrderingEditor from './SequenceOrderingEditor.vue';
import ResourceUsage from '../ResourceUsage.vue';
import { useDraftProtection } from '../../draft-protection';
import PageHelpButton from '../PageHelpButton.vue';
import { useDisclosureState } from '../../disclosure-state';
import ProgramMetadataEditor from './ProgramMetadataEditor.vue';
import ProgramPlaybackPreferences from './ProgramPlaybackPreferences.vue';
import type { AudioPreferences, SubtitlePreferences } from '@moirai/shared';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
	catalogProgramItemFilterSchema,
	mergeContentExclusions,
	MAX_EXPLICIT_MEDIA_GROUPS,
	programMetadataSchema,
	type ContentExclusions,
	type MediaGenreFacet,
	type MediaGroup,
	type MediaItem,
	type MediaSourcePickerEntry,
	type ProgramCreate,
	type ProgramContentSource,
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
import { randomUuid } from '../../random-uuid';
import { closeUnsavedEditor, confirmDraftNavigation } from '../../unsaved-editor';
import ProgramSelectionSummary from './ProgramSelectionSummary.vue';
import ProgramPlaybackOrder from './ProgramPlaybackOrder.vue';
import type { MediaSelectionProps } from './media-selection';
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
import { useProgramEditorBootstrap } from './program-editor-bootstrap';
import ProgramLibraryQuery from './ProgramLibraryQuery.vue';
import ProgramExclusions from './ProgramExclusions.vue';
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
const saving = ref(false);
let allowRouteLeave = false;
const error = ref('');
const aiConfigured = ref(false);
const draftRevision = ref(0);
const authentication = useAuthenticationStore();
const sourceEntries = ref<MediaSourcePickerEntry[]>([]);
const sourceLoading = ref(false);
const sourceLoaded = ref(false);
let sourceLoadSequence = 0;
const sourceParentId = ref<string>();
const sourcePage = ref(1);
const sourceTotalPages = ref(1);
const sourceSearch = ref('');
const subtitlesOpen = useDisclosureState('program-subtitles');
const selectedSourceLabel = ref('');
const selectedItems = ref<MediaItem[]>([]);
const selectedGroups = ref<MediaGroup[]>([]);
const selectedItemsLoading = ref(false);
const selectedItemsLoaded = ref(false);
const selectedGroupsLoading = ref(false);
const selectedGroupsLoaded = ref(false);
const selectionDrawerOpen = ref(false);
const selectedItemSearch = ref('');
const selectedOrderChosen = ref(false);
const selectionSummary = ref<InstanceType<typeof ProgramSelectionSummary>>();
let selectedItemsLoadSequence = 0;
let selectedGroupsLoadSequence = 0;
let unsubscribeLiveEvents: (() => void) | undefined;
const genres = ref<MediaGenreFacet[]>([]);
const queryPreviewRevision = ref(0);
const { editingId, savedIdentity, editorReady, editorOpen, initialLoading, initialError, missingProgram, programs, editorBaseline, loadEditor }
	= useProgramEditorBootstrap({
		identity: () => props.embedded ? props.programId ?? undefined
			: route.params.id === 'new' ? null : typeof route.params.id === 'string' ? route.params.id : undefined,
		onStart: () => {
			sourceLoadSequence += 1;
			selectedItemsLoadSequence += 1;
			selectedGroupsLoadSequence += 1;
			aiDraft.pause();
			error.value = '';
		},
		restoreDraft: openDraft,
		onDraftReady: baseline => {
			void Promise.all([loadSourceOptions(), loadSelectedItems(), loadSelectedGroups()]);
			if (props.embedded && baseline && !statuses.value.has(baseline.id)
				&& (baseline.config.type === 'similarity' || baseline.config.type === 'theme'
					|| (baseline.config.type === 'content' && ['item', 'group'].includes(baseline.config.source.type)))) {
				void scheduling.load();
			}
		},
	});
const statuses = computed(
	() =>
		new Map(
			(scheduling.overview?.programStatuses ?? []).map((status) => [status.programId, status]),
		),
);
const sourceDisplayLabel = computed(() => selectedSourceLabel.value
	|| (editingId.value ? statuses.value.get(editingId.value)?.sourceLabel : undefined)
	|| (editingId.value && form.sourceType === 'item' ? 'Selected item' : editingId.value && form.sourceType === 'group' ? 'Selected group' : ''));
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
	const items = form.sourceType === 'ai' ? selectedItems.value : selectedItemOrdering.orderedItems.value;
	if (!query) {
		return items;
	}

	return items.filter((item) => {
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
const selectionReviewProps = computed<MediaSelectionProps>(() => ({
	selectingGroups: selectingGroups.value, aiSelection: form.sourceType === 'ai',
	selectionCount: selectionCount.value, selectionLimit: selectionLimit.value,
	loading: selectingGroups.value ? selectedGroupsLoading.value : selectedItemsLoading.value,
	loaded: selectingGroups.value ? selectedGroupsLoaded.value : selectedItemsLoaded.value,
	missingItemCount: missingSelectedCount.value, missingGroupCount: missingSelectedGroupCount.value,
	items: filteredSelectedItems.value, groups: filteredSelectedGroups.value,
	selectedItemCount: selectedItems.value.length, selectedGroupCount: selectedGroups.value.length,
	itemReferenceCount: form.selectedItemIds.length, groupReferenceCount: form.selectedGroupIds.length,
	libraryType: selectedLibraryType.value, search: selectedItemSearch.value, sort: selectedItemSort.value,
}));

const sourceLibraries = computed(() =>
	form.sourceType === 'group' || form.sourceType === 'group-collection'
		? librariesStore.libraries.filter((library) => library.typeKey === 'shows')
		: librariesStore.libraries);
const sourceTypeLabel = computed(() => ({
	'library-query': 'Library query',
	collection: 'Specific media items',
	ai: 'AI',
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
	graphicsAssignment: undefined as GraphicsAssignment | undefined,
	audioPreferences: {} as AudioPreferences,
	name: '',
	metadataRows: [] as Array<{ id: string; key: string; value: string }>,
	type: 'content' as 'content' | 'sequence' | 'similarity' | 'theme',
	sourceProgramId: '',
	theme: '',
	variety: DEFAULT_SIMILARITY_VARIETY,
	quantity: DEFAULT_SIMILARITY_QUANTITY,
	softPreferences: '',
	exclusionText: '',
	exclusionStrictness: DEFAULT_SEMANTIC_EXCLUSION_STRICTNESS,
	sourceType: 'library-query' as
    'library-query' | 'collection' | 'item' | 'group' | 'group-collection' | 'ai',
	aiPrompt: '', aiSelectionPrompt: null as string | null, aiResultLimit: AI_DEFAULT_RESULT_COUNT as AiResultCount,
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
	contentExclusions: { itemIds: [], groupIds: [] } as ContentExclusions,
	excludedItemIds: [] as string[],
	selectedItemIds: [] as string[],
	selectedItemSort: 'date-added' as 'date-added' | 'name' | 'release-date' | 'episode' | 'manual',
	selectedItemSortDirection: 'asc' as 'asc' | 'desc',
	manualItemIds: [] as string[],
	selectedGroupIds: [] as string[],
	strategy: 'sequential' as 'sequential' | 'shuffle' | 'random' | 'weighted-random',
	seed: '',
	sequenceOrdering: 'ordered' as SequenceOrdering['type'],
	repeat: true,
	entries: [] as SequenceDraftEntry[],
});
const supportsContentExclusions = computed(() => form.sourceType !== 'item' && form.sourceType !== 'group');
const currentContentSource = computed<ProgramContentSource | null>(() => {
	if (form.sourceType === 'group-collection') {
		return form.selectedGroupIds.length ? { type: 'group-collection', libraryId: form.libraryId, groupIds: form.selectedGroupIds } : null;
	}
	if (!form.selectedItemIds.length) {
		return null;
	}
	if (form.sourceType === 'ai') {
		// Preserve AI date-indexed ordering without requiring or transmitting a valid draft prompt.
		return { type: 'ai', libraryId: form.libraryId, itemIds: form.selectedItemIds, sort: selectedItemSort.value, prompt: 'Current content' };
	}
	return { type: 'collection', libraryId: form.libraryId, sort: selectedItemSort.value, ...selectedItemOrdering.additionOrder.value };
});
const draftIdentity = computed(() => editingId.value ?? 'new');
const metadata = computed(() => Object.fromEntries(form.metadataRows.map(({ key, value }) => [key, value])));
const originalMetadata = ref(JSON.stringify(metadata.value));
const metadataDirty = computed(() => JSON.stringify(metadata.value) !== originalMetadata.value
	|| form.metadataRows.length !== Object.keys(metadata.value).length);
const metadataValid = computed(() => form.metadataRows.length === Object.keys(metadata.value).length
	&& programMetadataSchema.safeParse(metadata.value).success);
const originalSnapshot = ref(draftSnapshot());
const previewProgramNames = computed(() => new Map(programs.value.map(program => [program.id, program.name])));
const isDirty = computed(() => metadataDirty.value || draftSnapshot() !== originalSnapshot.value);
const aiDraft = useProgramDraft(form, () => draftIdentity.value, () => `moirai:ai-draft:${authentication.state?.identity?.id ?? 'anonymous'}:${draftIdentity.value}`, () => isDirty.value, () => metadataDirty.value);
const { generation: aiGeneration, warning: aiDraftWarning } = aiDraft;

/** Compare the active draft while retaining alternate Sequence quantities for mode switches. */
function draftSnapshot(): string {
	const draft = { ...form, metadataRows: undefined, aiResultLimit: AI_DEFAULT_RESULT_COUNT };
	if (form.type === 'sequence') {
		const ordering = sequenceOrdering();
		return JSON.stringify({ ...draft, entries: sequenceEntries(), seed: 'seed' in ordering ? ordering.seed : '' });
	}
	return JSON.stringify(draft);
}

/** Initialize the form from an existing program or safe defaults for a new content rule. */
function resetForm(program?: SchedulingProgram): void {
	draftRevision.value += 1;
	selectionDrawerOpen.value = false;
	selectedItemSearch.value = '';
	selectedOrderChosen.value = false;
	form.name = program?.name ?? '';
	form.metadataRows = Object.entries(program?.metadata ?? {}).map(([key, value]) => ({ id: randomUuid(), key, value }));
	originalMetadata.value = JSON.stringify(metadata.value);
	form.audioPreferences = cloneContractValue(program?.config.audioPreferences ?? {});
	form.graphicsAssignment = program?.config.graphicsAssignment;
	form.subtitlePreferences = cloneContractValue(program?.config.subtitlePreferences ?? {});
	form.type = program?.config.type ?? 'content';
	form.excludedItemIds = program?.config.type === 'similarity' || program?.config.type === 'theme' ? [...program.config.excludedItemIds ?? []] : [];
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
	form.contentExclusions = { itemIds: [], groupIds: [] };
	form.aiPrompt = '';
	form.aiSelectionPrompt = null;
	form.aiResultLimit = AI_DEFAULT_RESULT_COUNT;
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
		if ('exclusions' in source || source.type === 'ai') {
			const exclusions = mergeContentExclusions(source.exclusions, source.type === 'ai' ? source.excludedItemIds : undefined);
			if (exclusions) {
				form.contentExclusions = cloneContractValue(exclusions);
			}
		}
		switch (source.type) {
			case 'library-query':
				form.libraryId = source.libraryId;
				form.kinds = [...source.kinds];
				form.filter = catalogProgramItemFilterSchema.parse(source);
				form.querySort = { ...(source.sort ?? { type: 'name', direction: 'asc' }) };
				form.queryItemLimit = source.itemLimit ?? null;
				break;
			case 'ai':
				form.excludedItemIds = [...source.excludedItemIds ?? []];
				form.libraryId = source.libraryId;
				form.aiPrompt = source.prompt;
				form.aiSelectionPrompt = source.prompt.trim();
				form.selectedItemIds = [...source.itemIds];
				form.selectedItemSort = source.sort.type;
				form.selectedItemSortDirection = source.sort.type === 'manual' ? 'asc' : source.sort.direction;
				form.manualItemIds = source.sort.type === 'manual' ? [...source.sort.itemIds] : [];
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
				break;
			case 'group':
				form.sourceId = source.groupId;
				form.includeDescendants = source.includeDescendants;
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
		form.entries = program.config.entries.map(entry => ({
			...entry,
			count: form.sequenceOrdering === 'chance' ? 1 : entry.count,
			chance: form.sequenceOrdering === 'chance' ? entry.count : 100,
		}));
	}
	if (!program) {
		form.kinds = [...libraryQueryKinds.value];
	}
	sourceParentId.value = undefined;
	sourcePage.value = 1;
	sourceSearch.value = '';
	originalSnapshot.value = draftSnapshot();
}

/** Detect changes to saved metadata independently of the Program's scheduling revision. */
function draftVersion(program?: SchedulingProgram): string {
	const revision = program?.updatedAt ?? '';
	const entries = Object.entries(program?.metadata ?? {}).sort(([left], [right]) => left.localeCompare(right));
	return entries.length ? `${revision}:${JSON.stringify(entries)}` : revision;
}

/** Restore browser-owned Program work after loading the current saved program. */
async function openDraft(program?: SchedulingProgram, restore = true): Promise<void> {
	await aiDraft.open(draftVersion(program), () => resetForm(program), restore);
}

/** Load genre facets or paged source choices while discarding superseded responses. */
async function loadSourceOptions(): Promise<void> {
	const sequence = ++sourceLoadSequence;
	if (!form.libraryId || form.type === 'sequence' || form.type === 'similarity'
		|| (form.type === 'content' && form.sourceType === 'ai')) {
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
				: selectedLibraryType.value === 'shows' && sourceSearch.value.trim() ? 'all' : 'items',
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
	if (form.sourceType !== 'collection'
		|| !form.libraryId || form.selectedItemIds.length === 0) {
		selectedItems.value = [];
		selectedItemsLoading.value = false;
		selectedItemsLoaded.value = true;
		return;
	}

	selectedItemsLoading.value = true;
	selectedItemsLoaded.value = false;
	try {
		const requestedIds = [...(form.selectedItemSort === 'manual'
			? form.manualItemIds
			: selectedItemOrdering.additionOrder.value.itemIds)];
		const items = await api.mediaSelection(form.libraryId, requestedIds);
		if (sequence === selectedItemsLoadSequence) {
			const requested = new Set(requestedIds);
			const added = selectedItems.value.filter(item => !requested.has(item.id));
			const ids = form.selectedItemSort === 'manual' ? form.manualItemIds : form.selectedItemIds;
			selectedItems.value = itemsInReferenceOrder(ids, [...items, ...added]);
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
		const requestedIds = [...form.selectedGroupIds];
		const groups = await api.mediaGroupSelection(form.libraryId, requestedIds);
		if (sequence === selectedGroupsLoadSequence) {
			const requested = new Set(requestedIds);
			const added = selectedGroups.value.filter(group => !requested.has(group.id));
			const byId = new Map([...groups, ...added].map(group => [group.id, group]));
			selectedGroups.value = form.selectedGroupIds.flatMap(id => {
				const group = byId.get(id);
				return group ? [group] : [];
			});
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
		if (selectedLibraryType.value === 'shows' && (form.sourceType === 'item' || form.sourceType === 'collection')) {
			sourceSearch.value = '';
		}
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
	selectedItemsLoaded.value = !selectedItemsLoading.value;
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
	selectedGroupsLoaded.value = !selectedGroupsLoading.value;
}

/** Remove one explicit item from both the request identifiers and review cards. */
function removeSelectedItem(id: string): void {
	form.selectedItemIds = form.selectedItemIds.filter((candidate) => candidate !== id);
	form.manualItemIds = form.manualItemIds.filter((candidate) => candidate !== id);
	selectedItems.value = selectedItems.value.filter((item) => item.id !== id);
}

/** Change selected-media ordering and freeze the current display when entering Manual. */
function changeSelectedItemSort(value: 'date-added' | 'name' | 'release-date' | 'episode' | 'manual'): void {
	selectedOrderChosen.value = true;

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

/** Retain a deliberate direction choice when applying defaults for a new source. */
function changeSelectedItemSortDirection(value: 'asc' | 'desc'): void {
	selectedOrderChosen.value = true;
	form.selectedItemSortDirection = value;
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
	selectionSummary.value?.focus();
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


/** Default new episode selections without replacing a saved or deliberately chosen order. */
function defaultSelectedItemSort(): void {
	if (!editingId.value && !selectedOrderChosen.value && form.sourceType === 'collection') {
		form.selectedItemSort = selectedLibraryType.value === 'shows' ? 'episode' : 'date-added';
		form.selectedItemSortDirection = 'asc';
	}
}

/** Clear selections and filters that cannot carry across a source-library change. */
function changeSourceLibrary(): void {
	defaultSelectedItemSort();
	form.contentExclusions = { itemIds: [], groupIds: [] };
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
	if (form.sourceType === 'ai') {
		form.excludedItemIds = [];
		form.aiPrompt = '';
		form.aiSelectionPrompt = null;
		form.selectedItemIds = [];
		form.manualItemIds = [];
		form.selectedItemSort = 'date-added';
		form.selectedItemSortDirection = 'asc';
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
	form.aiSelectionPrompt = null;
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
	if (previousLibraryId !== form.libraryId) {
		form.contentExclusions = { itemIds: [], groupIds: [] };
	}
	if (form.sourceType === 'library-query') {
		form.kinds = [...libraryQueryKinds.value];
		form.filter = emptyCatalogProgramItemFilter();
		form.querySort = { type: 'name', direction: 'asc' };
		form.queryItemLimit = null;
	}
	defaultSelectedItemSort();
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
	return form.sequenceOrdering === 'shuffled-blocks' || form.sequenceOrdering === 'shuffled-allocations' || form.sequenceOrdering === 'chance'
		? { type: form.sequenceOrdering, seed: form.seed }
		: { type: form.sequenceOrdering };
}

/** Serialize only the quantities belonging to the active Sequence mode. */
function sequenceEntries() {
	return form.entries.map(({ id, programId, count, chance }) => {
		const quantity = form.sequenceOrdering === 'chance' ? chance : count;
		return { id, programId, count: quantity === '' ? NaN : quantity };
	});
}

/** Append a sequence entry using the first program other than the one being edited. */
function addSequenceEntry(): void {
	const candidate = programs.value.find((program) => program.id !== editingId.value);
	if (candidate) {
		form.entries.push({ id: randomUuid(), programId: candidate.id, count: 1, chance: 100 });
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
			excludedItemIds: form.excludedItemIds, variety: form.variety, quantity: form.quantity, softPreferences: form.softPreferences,
			hardExclusions: form.exclusionText.split(',').map((text) => text.trim()).filter(Boolean), exclusionStrictness: form.exclusionStrictness, graphicsAssignment: form.graphicsAssignment, subtitlePreferences: form.subtitlePreferences,
			audioPreferences: form.audioPreferences } };
	}
	if (form.type === 'sequence') {
		const ordering = sequenceOrdering();
		return {
			name: form.name,
			config: {
				type: 'sequence',
				ordering,
				entries: sequenceEntries(),
				repeat: form.repeat,
				graphicsAssignment: form.graphicsAssignment,
				subtitlePreferences: form.subtitlePreferences,
				audioPreferences: form.audioPreferences,
			},
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

	const excludedIds = new Set(form.contentExclusions.itemIds);
	const generatedIds = new Set(form.sourceType === 'ai' ? form.selectedItemIds : []);
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
						: form.sourceType === 'ai'
							? ({
								type: 'ai',
								libraryId: form.libraryId,
								prompt: form.aiPrompt.trim(),
								excludedItemIds: form.excludedItemIds.filter(id => excludedIds.has(id) && !generatedIds.has(id)),
								itemIds: form.selectedItemIds,
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
	const legacyExclusions = new Set(source.type === 'ai' ? source.excludedItemIds : []);
	const itemIds = form.contentExclusions.itemIds.filter(id => !legacyExclusions.has(id));
	const { groupIds } = form.contentExclusions;
	const contentSource = supportsContentExclusions.value && (itemIds.length || groupIds.length)
		? { ...source, exclusions: { itemIds, groupIds } }
		: source;
	return { name: form.name, config: { type: 'content', source: contentSource, strategy, graphicsAssignment: form.graphicsAssignment, subtitlePreferences: form.subtitlePreferences, audioPreferences: form.audioPreferences } };
}
const { deleting, resetProgram, deleteProgram } = useProgramResourceActions({
	program: () => editorBaseline.value,
	embedded: () => props.embedded,
	saving: () => saving.value,
	resetDraft: (program) => {
		aiDraft.clear();
		void openDraft(program, false);
		error.value = '';
	},
	reloadDraft: async () => await Promise.all([
		loadSourceOptions(), loadSelectedItems(), loadSelectedGroups(),
	]).then(() => undefined),
	onDeleted: async () => {
		aiDraft.clear();
		await scheduling.load();
		await leaveEditor();
	},
	onError: (cause) => error.value = errorMessage(cause),
});

const subtitlesInvalid = ref(false);
const programSaveDisabled = computed(() =>
	!editorReady.value || saving.value || deleting.value || Boolean(aiGeneration.value) || subtitlesInvalid.value || !metadataValid.value || !isProgramDraftValid(payload)
	|| (Boolean(editingId.value) && !isDirty.value));

/** Commit the Program, leaving navigation to the active route guard when requested. */
async function save(stayOnPage = false): Promise<boolean> {
	if (programSaveDisabled.value) {
		return false;
	}

	saving.value = true;
	error.value = '';
	try {
		const fields = metadataDirty.value ? { metadata: metadata.value } : {};
		const operation = editingId.value
			? api.updateProgram(editingId.value, draftSnapshot() === originalSnapshot.value ? fields : { ...payload(), ...fields })
			: api.createProgram({ ...payload(), ...fields });
		const saved = await operation;
		aiDraft.clear();
		programs.value = [...programs.value.filter(program => program.id !== saved.id), saved];
		const requestedCount = form.aiResultLimit;
		resetForm(saved);
		form.aiResultLimit = requestedCount;
		savedIdentity.value = saved.id;
		originalSnapshot.value = draftSnapshot();
		if (!props.embedded && !stayOnPage) {
			allowRouteLeave = true;
			try {
				await router.replace({ path: `/schedules/programs/${saved.id}`, query: route.query });
			}
			finally {
				allowRouteLeave = false;
			}
		}
		await aiDraft.open(draftVersion(saved), () => {}, false);
		await scheduling.load();
		if (!stayOnPage) {
			await Promise.all([loadSelectedItems(), loadSelectedGroups()]);
		}
		emit('saved', saved.id);
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

/** Return to the collection after dismissal or deletion without rerunning the route guard. */
async function leaveEditor(): Promise<void> {
	allowRouteLeave = true;
	try {
		await router.push({ path: '/schedules/programs', query: route.query });
	}
	finally {
		allowRouteLeave = false;
	}
}

/** Retain the Program on close, protecting pending work if browser recovery fails. */
async function closeEditor(): Promise<void> {
	if (!editorReady.value) {
		if (props.embedded) {
			emit('close');
		}
		else {
			await leaveEditor();
		}
		return;
	}
	await closeUnsavedEditor({
		blocked: saving.value || deleting.value, dirty: isDirty.value || Boolean(aiGeneration.value),
		retainedDraft: aiDraft, isDirty: () => isDirty.value,
		key: `unsaved-program:${editingId.value ?? 'new'}`, message: 'Save this program before closing?',
		save, discard: () => props.embedded ? emit('close') : leaveEditor(),
	});
}

/** Retain the current draft before navigating to another resource or page. */
async function confirmRouteLeave(): Promise<boolean> {
	if (allowRouteLeave || !editorOpen.value || !editorReady.value) {
		return true;
	}
	return confirmDraftNavigation({
		blocked: saving.value || deleting.value, dirty: isDirty.value || Boolean(aiGeneration.value),
		retainedDraft: aiDraft, isDirty: () => isDirty.value,
		key: `unsaved-program:${editingId.value ?? 'new'}`, message: 'Save this program before leaving?', save: () => save(true),
	});
}
onBeforeRouteLeave(confirmRouteLeave);
onBeforeRouteUpdate(async (to, from) => to.params.id === from.params.id || await confirmRouteLeave());

watch(() => [form.libraryId, form.type], () => {
	if (editorReady.value) {
		void loadSourceOptions();
	}
});
onMounted(() => {
	unsubscribeLiveEvents = subscribeToSelectedMediaRefresh(
		() => form.libraryId,
		() => editorReady.value && (form.type === 'theme' || form.sourceType === 'collection' || form.sourceType === 'library-query'),
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
	void api.aiStatus().then(status => {
		aiConfigured.value = status.configured;
	}).catch(() => undefined);
});
onBeforeUnmount(() => {
	unsubscribeLiveEvents?.();
});
useDraftProtection(() => editorOpen.value && editorReady.value && (isDirty.value || Boolean(aiGeneration.value)) && aiDraft.unsafe.value);
watch(() => [form.type, form.sourceType], () => {
	if (form.type !== 'content' || !supportsContentExclusions.value) {
		form.contentExclusions = { itemIds: [], groupIds: [] };
	}
	if (form.type !== 'content' || form.sourceType !== 'ai') {
		if (aiGeneration.value) {
			void api.cancelAiGeneration(aiGeneration.value).catch(() => {});
			aiGeneration.value = null;
		}
	}
}, { flush: 'sync' });
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
						{{ !editorReady ? 'Program editor' : editingId ? `Edit ${form.type} rule` : 'New program' }}
					</p>
					<div class="resource-editor-title-with-help"><h2 id="program-editor-title">
						{{ initialLoading ? 'Loading Program' : editingId ? 'Edit Program' : 'Create Program' }}
					</h2><PageHelpButton label="Programs" topic-id="scheduling.programs" /></div>
					<p v-if="editorReady">
						{{
							form.type === 'content'
								? 'Define what content can play and how it should be selected.'
								: form.type === 'theme' ? 'Find media matching a theme in a target library.' : form.type === 'similarity' ? 'Select related media from a Specific media items or AI Program.' : 'Arrange reusable programs in a custom repeating order.'
						}}
					</p>
				</ResourceEditorHeader>
				<LoadingState v-if="initialLoading" label="Loading program editor…" />
				<div v-else-if="initialError || missingProgram" class="program-editor-scroll">
					<p class="notice error" role="alert">{{ initialError || 'Program not found. It may have been deleted.' }}
						<button v-if="initialError" type="button" class="button secondary" @click="loadEditor">Retry</button>
					</p>
				</div>
				<div v-else :inert="saving || deleting" class="program-editor-scroll">
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
												<option v-if="aiConfigured || form.sourceType === 'ai'" value="ai">AI</option>
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

										<template v-if="form.sourceType === 'ai'">
											<ProgramAiSource
												v-model:prompt="form.aiPrompt" v-model:selection-prompt="form.aiSelectionPrompt" v-model:max-results="form.aiResultLimit"
												v-model:generation="aiGeneration" v-model:item-ids="form.selectedItemIds" v-model:sort-type="form.selectedItemSort"
												v-model:sort-direction="form.selectedItemSortDirection" :exclusions="form.contentExclusions"
												:library-id="form.libraryId" :library-type="selectedLibraryType" :draft-revision="draftRevision" :sequential="form.strategy === 'sequential'"
											/>
											<ProgramExclusions v-model="form.contentExclusions" :current-source="currentContentSource" :result-ids="form.selectedItemIds" :library-id="form.libraryId" :library-type="selectedLibraryType" :library-name="sourceLibraryLabel" :disabled="Boolean(aiGeneration)" @remove-missing="removeSelectedItem" />
										</template>
										<template v-else-if="form.sourceType === 'library-query'">
											<ProgramLibraryQuery
												v-model="form.filter"
												v-model:sort="form.querySort"
												v-model:item-limit="form.queryItemLimit"
												v-model:exclusions="form.contentExclusions"
												:kinds="form.kinds"
												:library-id="form.libraryId"
												:library-type="selectedLibraryType"
												:library-name="sourceLibraryLabel"
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
												Selected: {{ sourceDisplayLabel || 'None' }}
											</p>
											<ProgramSelectionSummary v-else ref="selectionSummary" v-bind="selectionReviewProps" @review="openSelectionDrawer" />
											<label v-if="form.sourceType === 'group'" class="check-row"
											><input v-model="form.includeDescendants" type="checkbox" />Include
												descendants</label
											>
											<ProgramSourceBrowser
												v-model:search="sourceSearch"
												:source-type="form.sourceType" :library-type="selectedLibraryType"
												:source-entries="sourceEntries" :source-loading="sourceLoading" :source-loaded="sourceLoaded"
												:source-parent-id="sourceParentId" :source-page="sourcePage" :source-total-pages="sourceTotalPages"
												:selected-id-set="selectedIdSet" :selected-group-id-set="selectedGroupIdSet"
												@search="searchSources" @browse="browseGroup" @select="selectSource"
												@toggle-item="toggleSelectedItem" @toggle-group="toggleSelectedGroup" @page="changeSourcePage"
												@root="sourceParentId = undefined; sourcePage = 1; loadSourceOptions();"
											/>
											<ProgramExclusions v-if="supportsContentExclusions" v-model="form.contentExclusions" :current-source="currentContentSource" :library-id="form.libraryId" :library-type="selectedLibraryType" :library-name="sourceLibraryLabel" />
										</template>
									</div>
								</section>
								<SelectionStrategyEditor v-model="form.strategy" v-model:seed="form.seed">
									<ProgramPlaybackOrder
										v-if="form.strategy === 'sequential'" v-bind="selectionReviewProps"
										:source-type="form.sourceType" :query-sort="form.querySort" :source-label="sourceDisplayLabel" :reset-revision="draftRevision"
										@update:search="selectedItemSearch = $event" @update:sort-type="changeSelectedItemSort"
										@update:sort-direction="changeSelectedItemSortDirection"
										@reorder-items="reorderSelectedItems" @move-item="moveSelectedItem"
										@retry="loadSelectedItems" @remove-item="removeSelectedItem" @remove-group="removeSelectedGroup"
									/>
								</SelectionStrategyEditor>
							</template>

							<SimilarityProgramEditor v-else-if="form.type === 'similarity' || form.type === 'theme'" v-model:excluded-item-ids="form.excludedItemIds" v-model:filter="form.filter" v-model:theme="form.theme" v-model:library-id="form.libraryId" v-model:source-program-id="form.sourceProgramId" v-model:variety="form.variety" v-model:quantity="form.quantity" v-model:soft-preferences="form.softPreferences" v-model:exclusion-text="form.exclusionText" v-model:exclusion-strictness="form.exclusionStrictness" :genres="genres" :filters-loading="sourceLoading" :filters-loaded="sourceLoaded" :type="form.type" :libraries="librariesStore.libraries" :read-only-source="Boolean(editingId)" :programs="programs" :status="statuses.get(editingId ?? '')" />
							<SequenceProgramEditor
								v-else
								v-model:entries="form.entries"
								v-model:repeat="form.repeat"
								:chance="form.sequenceOrdering === 'chance'"
								:programs="programs"
								:editing-id="editingId"
								@add="addSequenceEntry"
								@move="moveEntry"
								@remove="form.entries.splice($event, 1)"
							/>
							<SequenceOrderingEditor v-if="form.type === 'sequence'" v-model="form.sequenceOrdering" v-model:seed="form.seed" />
							<SequenceGuidePreview v-if="form.type === 'sequence'" :config="payload().config" :program-id="editingId ?? undefined" :program-names="previewProgramNames" />
							<ProgramPlaybackPreferences v-model:open="subtitlesOpen" v-model:audio="form.audioPreferences" v-model:subtitles="form.subtitlePreferences" :program-id="editingId" :reset-revision="draftRevision" :step="form.type === 'content' || form.type === 'sequence' ? 3 : 2" @validation-change="subtitlesInvalid = $event" />
							<GraphicsAssignmentEditor v-model="form.graphicsAssignment" description="These graphics follow this Program wherever it plays." />
							<ProgramMetadataEditor v-model="form.metadataRows" :disabled="saving || deleting" :step="form.type === 'content' || form.type === 'sequence' ? 4 : 3" />
						</div>
					</div></ResourceUsage>
				</div>
				<ResourceEditorActionBar
					v-if="editorReady" :pending="!editingId || isDirty"
					:draft-warning="aiDraftWarning" :draft-restored="aiDraft.recovered.value" :save-label="editingId ? 'Save' : 'Add'"
					resource-type="Program"
					:validation-message="subtitlesInvalid ? 'Complete the specific subtitle rules before saving.' : !metadataValid ? 'Correct the metadata keys before saving.' : ''"
					:show-delete="!embedded && Boolean(editingId)"
					:busy="saving || deleting" :deleting="deleting"
					:reset-disabled="!isDirty && !aiGeneration" :save-disabled="programSaveDisabled"
					:saving="saving" save-submits
					@close="closeEditor"
					@delete="deleteProgram" @reset="resetProgram"
				/>
			</form>
		</div>
		<MediaSelectionDrawer
			v-if="selectionDrawerOpen"
			v-bind="selectionReviewProps"
			@update:search="selectedItemSearch = $event"
			@update:sort-type="changeSelectedItemSort"
			@update:sort-direction="changeSelectedItemSortDirection"
			@reorder-items="reorderSelectedItems"
			@move-item="moveSelectedItem"
			@close="closeSelectionDrawer"
			@clear="clearSelectedItems"
			@retry="selectingGroups ? loadSelectedGroups() : loadSelectedItems()"
			@remove-item="removeSelectedItem"
			@remove-group="removeSelectedGroup"
		/>
	</section>
</template>
