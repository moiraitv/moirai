<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
	Asterisk,
	Check,
	Layers3,
	Plus,
	Trash2,
	X,
} from '@lucide/vue';
import {
	MAX_EXPLICIT_MEDIA_GROUPS,
	MAX_EXPLICIT_MEDIA_ITEMS,
	type MediaGroup,
	type MediaItem,
	type MediaSourcePickerEntry,
	type ProgramCreate,
	type SchedulingProgram,
} from '@moirai/shared';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import { cloneContractValue } from '../../reactive-clone';
import LoadingState from '../../components/LoadingState.vue';
import { mediaGroupSubtitle, mediaItemSubtitle } from '../../media-labels';
import { useLibrariesStore } from '../../stores/libraries';
import { useSchedulingStore } from '../../stores/scheduling';
import { artworkSrcset, artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';
import MediaSelectionDrawer from './MediaSelectionDrawer.vue';
import ProgramTypeRail from './ProgramTypeRail.vue';
import SelectionStrategyEditor from './SelectionStrategyEditor.vue';
import SequenceProgramEditor from './SequenceProgramEditor.vue';

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
const initialLoading = ref(!(scheduling.loaded && librariesStore.loaded));
const saving = ref(false);
const error = ref('');
const sourceEntries = ref<MediaSourcePickerEntry[]>([]);
const sourceLoading = ref(false);
const sourceLoaded = ref(false);
let sourceLoadSequence = 0;
const sourceParentId = ref<string>();
const sourcePage = ref(1);
const sourceTotalPages = ref(1);
const sourceSearch = ref('');
const selectedSourceLabel = ref('');
const genreToAdd = ref('');
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
const genres = ref<Array<{ key: string; name: string }>>([]);
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
	selectingGroups.value ? MAX_EXPLICIT_MEDIA_GROUPS : MAX_EXPLICIT_MEDIA_ITEMS);
const selectionLoading = computed(() =>
	selectingGroups.value ? selectedGroupsLoading.value : selectedItemsLoading.value);
const selectionLoaded = computed(() =>
	selectingGroups.value ? selectedGroupsLoaded.value : selectedItemsLoaded.value);
const missingSelectedCount = computed(
	() => form.selectedItemIds.length - selectedItems.value.length,
);
const filteredSelectedItems = computed(() => {
	const query = selectedItemSearch.value.trim().toLocaleLowerCase();
	if (!query) {
		return selectedItems.value;
	}

	return selectedItems.value.filter((item) => {
		const subtitle = mediaItemSubtitle(selectedLibraryType.value, item) || item.kind;
		return `${item.title} ${subtitle}`.toLocaleLowerCase().includes(query);
	});
});
const missingSelectedGroupCount = computed(
	() => form.selectedGroupIds.length - selectedGroups.value.length,
);
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
const selectedLibraryType = computed(
	() =>
		librariesStore.libraries.find((library) => library.id === form.libraryId)?.typeKey ?? 'other',
);
const availableKinds = computed(() => {
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
	name: '',
	type: 'content' as 'content' | 'sequence',
	sourceType: 'library-query' as
    'library-query' | 'collection' | 'item' | 'group' | 'group-collection',
	libraryId: '',
	sourceId: '',
	includeDescendants: true,
	kinds: [] as string[],
	genres: [] as string[],
	selectedItemIds: [] as string[],
	selectedGroupIds: [] as string[],
	strategy: 'sequential' as 'sequential' | 'shuffle' | 'random',
	seed: '',
	repeat: true,
	entries: [] as Array<{ id: string; programId: string; count: number }>,
});

/** Initialize the form from an existing program or safe defaults for a new content rule. */
function resetForm(program?: SchedulingProgram): void {
	selectionDrawerOpen.value = false;
	selectedItemSearch.value = '';
	form.name = program?.name ?? '';
	form.type = program?.config.type ?? 'content';
	form.sourceType = 'library-query';
	form.libraryId = librariesStore.libraries[0]?.id ?? '';
	form.sourceId = '';
	form.includeDescendants = true;
	form.kinds = [];
	form.genres = [];
	form.selectedItemIds = [];
	form.selectedGroupIds = [];
	form.strategy = 'sequential';
	form.seed = '';
	form.repeat = true;
	form.entries = [];
	selectedSourceLabel.value = '';
	selectedItems.value = [];
	selectedItemsLoaded.value = false;
	selectedGroups.value = [];
	selectedGroupsLoaded.value = false;
	genreToAdd.value = '';
	if (program?.config.type === 'content') {
		const source = program.config.source;
		form.sourceType = source.type;
		switch (source.type) {
			case 'library-query':
				form.libraryId = source.libraryId;
				form.kinds = [...source.kinds];
				form.genres = [...source.genres];
				break;
			case 'collection':
				form.libraryId = source.libraryId;
				form.selectedItemIds = [...source.itemIds];
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
		form.repeat = program.config.repeat;
		form.entries = cloneContractValue(program.config.entries);
	}
	if (!program) {
		form.kinds = [...availableKinds.value];
	}
	sourceParentId.value = undefined;
	sourcePage.value = 1;
	sourceSearch.value = '';
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
		if (form.sourceType === 'library-query') {
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
		const items = await api.mediaSelection(form.libraryId, form.selectedItemIds);
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
		selectedItems.value = selectedItems.value.filter((selected) => selected.id !== item.id);
		return;
	}

	if (form.selectedItemIds.length >= MAX_EXPLICIT_MEDIA_ITEMS) {
		error.value = `A collection can contain at most ${MAX_EXPLICIT_MEDIA_ITEMS} items.`;
		return;
	}

	form.selectedItemIds.push(item.id);
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
	selectedItems.value = selectedItems.value.filter((item) => item.id !== id);
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
	if (!confirm(`Remove all selected ${groups ? 'media groups' : 'media items'}?`)) {
		return;
	}

	if (groups) {
		form.selectedGroupIds = [];
		selectedGroups.value = [];
		selectedGroupsLoaded.value = true;
	}
	else {
		form.selectedItemIds = [];
		selectedItems.value = [];
		selectedItemsLoaded.value = true;
	}
	selectedItemSearch.value = '';
}

/** Close the innermost open program surface when Escape is pressed. */
function handleSelectionDrawerKeydown(event: KeyboardEvent): void {
	if (selectionDrawerOpen.value && event.key === 'Escape') {
		event.preventDefault();
		event.stopImmediatePropagation();
		void closeSelectionDrawer();
	}
	else if (editorOpen.value && event.key === 'Escape') {
		event.preventDefault();
		event.stopImmediatePropagation();
		closeEditor();
	}
}

/** Clear selections and filters that cannot carry across a source-library change. */
function changeSourceLibrary(): void {
	selectionDrawerOpen.value = false;
	selectedItemSearch.value = '';
	form.sourceId = '';
	selectedSourceLabel.value = '';
	if (form.sourceType === 'collection') {
		form.selectedItemIds = [];
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
		form.kinds = [...availableKinds.value];
		form.genres = [];
		genreToAdd.value = '';
	}
}

/** Reset source-specific state and load choices valid for the newly selected source type. */
function changeSourceType(): void {
	selectionDrawerOpen.value = false;
	selectedItemSearch.value = '';
	const previousLibraryId = form.libraryId;
	form.sourceId = '';
	selectedSourceLabel.value = '';
	form.selectedItemIds = [];
	form.selectedGroupIds = [];
	selectedItems.value = [];
	selectedItemsLoaded.value = true;
	selectedGroups.value = [];
	selectedGroupsLoaded.value = true;
	sourceParentId.value = undefined;
	sourcePage.value = 1;
	sourceSearch.value = '';
	if (!sourceLibraries.value.some((library) => library.id === form.libraryId)) {
		form.libraryId = sourceLibraries.value[0]?.id ?? '';
	}
	if (form.sourceType === 'library-query') {
		form.kinds = [...availableKinds.value];
		form.genres = [];
		genreToAdd.value = '';
	}
	if (previousLibraryId === form.libraryId) {
		void loadSourceOptions();
	}
}

/** Build the compact metadata line shown for a source result. */
function sourceEntrySubtitle(entry: MediaSourcePickerEntry): string {
	if (entry.group) {
		return mediaGroupSubtitle(selectedLibraryType.value, entry.group) || entry.group.kind;
	}

	if (entry.item) {
		return mediaItemSubtitle(selectedLibraryType.value, entry.item) || entry.item.kind;
	}

	return '';
}

/** Describe which metadata field matched the source search. */
function sourceMatchText(entry: MediaSourcePickerEntry): string {
	return entry.matches
		.filter((match) => match.field !== 'title')
		.map(
			(match) => `${match.field.charAt(0).toUpperCase() + match.field.slice(1)} · ${match.label}`,
		)
		.join(' · ');
}

/** Return the user-facing label for genre. */
function genreLabel(key: string): string {
	return genres.value.find((genre) => genre.key === key)?.name ?? key;
}

/** Add one deduplicated media-kind filter from the picker. */
function addMediaKind(event: Event): void {
	const select = event.target as HTMLSelectElement;
	if (select.value && !form.kinds.includes(select.value)) {
		form.kinds.push(select.value);
	}
	select.value = '';
}

/** Add the selected genre filter once, then reset the picker. */
function addGenre(): void {
	if (genreToAdd.value && !form.genres.includes(genreToAdd.value)) {
		form.genres.push(genreToAdd.value);
	}
	genreToAdd.value = '';
}

/** Remove one genre from the library-query filters. */
function removeGenre(key: string): void {
	form.genres = form.genres.filter((genre) => genre !== key);
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

/** Append a sequence entry using the first program other than the one being edited. */
function addSequenceEntry(): void {
	const candidate = programs.value.find((program) => program.id !== editingId.value);
	if (candidate) {
		form.entries.push({ id: crypto.randomUUID(), programId: candidate.id, count: 1 });
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
	if (form.type === 'sequence') {
		return {
			name: form.name,
			config: { type: 'sequence', entries: form.entries, repeat: form.repeat },
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
							itemIds: form.selectedItemIds,
						} as const)
						: ({
							type: 'library-query',
							libraryId: form.libraryId,
							kinds: form.kinds,
							genres: form.genres,
						} as const);
	return { name: form.name, config: { type: 'content', source, strategy } };
}

/** Validate and save the program draft, optionally starting another draft. */
async function save(addAnother = false): Promise<void> {
	saving.value = true;
	error.value = '';
	try {
		const operation = editingId.value
			? api.updateProgram(editingId.value, payload())
			: api.createProgram(payload());
		const saved = await operation;
		await scheduling.load();
		if (addAnother && !editingId.value) {
			resetForm();
			await Promise.all([loadSourceOptions(), loadSelectedItems(), loadSelectedGroups()]);
			return;
		}

		if (props.embedded) {
			emit('saved', saved.id);
		}
		else {
			await router.push('/schedules/programs');
		}
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		saving.value = false;
	}
}

/** Close the embedded editor or return the standalone editor to the program list. */
function closeEditor(): void {
	if (props.embedded) {
		emit('close');
	}
	else {
		void router.push('/schedules/programs');
	}
}

watch(
	() => [route.params.id, props.programId],
	() => {
		const program = programs.value.find((candidate) => candidate.id === editingId.value);
		resetForm(program);
		void Promise.all([loadSourceOptions(), loadSelectedItems(), loadSelectedGroups()]);
	},
);
watch(
	() => form.libraryId,
	() => void loadSourceOptions(),
);
onMounted(async () => {
	document.addEventListener('keydown', handleSelectionDrawerKeydown);
	try {
		await Promise.all([scheduling.load(), librariesStore.load()]);
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
	document.removeEventListener('keydown', handleSelectionDrawerKeydown);
});
</script>

<template>
	<section>
		<div
			v-if="editorOpen && !initialLoading"
			class="modal-backdrop"
			:class="{ 'nested-modal-backdrop': embedded }"
			@click.self="closeEditor"
		>
			<form
				class="modal schedule-editor-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="program-editor-title"
				@submit.prevent="save()"
			>
				<header class="program-editor-header">
					<div>
						<p class="eyebrow">{{ editingId ? 'Edit' : 'New' }} program</p>
						<h2 id="program-editor-title">
							{{ editingId ? 'Edit' : 'Create' }} {{ form.type }} rule
						</h2>
						<p>
							{{
								form.type === 'content'
									? 'Define what content can play and how it should be selected.'
									: 'Arrange reusable programs in a custom repeating order.'
							}}
						</p>
					</div>
					<button
						type="button"
						class="program-editor-close"
						aria-label="Close"
						@click="closeEditor"
					>
						×
					</button>
				</header>
				<div class="program-editor-scroll">
					<ProgramTypeRail v-model="form.type" />
					<div class="program-editor-main">
						<p v-if="error" class="notice error">{{ error }}</p>
						<label class="program-name-field">
							<span>Name</span>
							<small>A descriptive name for this {{ form.type }} rule.</small>
							<input
								v-model="form.name"
								required
								:placeholder="
									form.type === 'content' ? 'e.g. Primetime Movies' : 'e.g. Evening Lineup'
								"
							/>
						</label>

						<template v-if="form.type === 'content'">
							<section class="program-editor-section">
								<div class="program-section-heading">
									<span>1</span><strong>Content source</strong>
								</div>
								<p class="program-section-description">Choose the source of eligible media.</p>
								<div class="program-source-panel">
									<div class="form-grid">
										<label
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
										<label
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
										<label>
											<span>Media kinds</span>
											<div class="program-token-field">
												<span v-for="kind in form.kinds" :key="kind" class="program-token">
													{{ kind }}
													<button
														type="button"
														:aria-label="`Remove ${kind}`"
														@click="form.kinds = form.kinds.filter((value) => value !== kind)"
													>
														<X :size="15" />
													</button>
												</span>
												<select aria-label="Add media kind" @change="addMediaKind">
													<option value="">Add media kind…</option>
													<option
														v-for="kind in availableKinds.filter(
															(candidate) => !form.kinds.includes(candidate),
														)"
														:key="kind"
														:value="kind"
													>
														{{ kind }}
													</option>
												</select>
											</div>
										</label>
										<label>
											<span>Genres <small>(optional)</small></span>
											<div class="program-token-field">
												<span v-for="genre in form.genres" :key="genre" class="program-token">
													{{ genreLabel(genre) }}
													<button
														type="button"
														:aria-label="`Remove ${genreLabel(genre)}`"
														@click="removeGenre(genre)"
													>
														×
													</button>
												</span>
												<select v-model="genreToAdd" aria-label="Add genre" @change="addGenre">
													<option value="">Add genre…</option>
													<option
														v-for="genre in genres.filter(
															(candidate) => !form.genres.includes(candidate.key),
														)"
														:key="genre.key"
														:value="genre.key"
													>
														{{ genre.name }}
													</option>
												</select>
											</div>
										</label>
										<button
											v-if="form.kinds.length || form.genres.length"
											type="button"
											class="program-clear-filters"
											@click="
												form.kinds = [];
												form.genres = [];
											"
										>
											Clear all <Trash2 :size="14" />
										</button>
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
															: MAX_EXPLICIT_MEDIA_ITEMS
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
													Review selection
												</button>
											</div>
										</div>
										<label v-if="form.sourceType === 'group'" class="check-row"
										><input v-model="form.includeDescendants" type="checkbox" />Include
											descendants</label
										>
										<div class="source-picker-toolbar">
											<input
												v-model="sourceSearch"
												type="search"
												aria-label="Search source media"
												placeholder="Search title, genre, actor, or director…"
												@keydown.enter.prevent="searchSources"
											/>
											<button type="button" class="toolbar-button" @click="searchSources">
												Search
											</button>
										</div>
										<button
											v-if="sourceParentId"
											type="button"
											class="text-button"
											@click="
												sourceParentId = undefined;
												sourcePage = 1;
												loadSourceOptions();
											"
										>
											Back to library root
										</button>
										<LoadingState v-if="sourceLoading" label="Loading source media…" />
										<div v-else-if="sourceEntries.length" class="source-picker-list">
											<article v-for="entry in sourceEntries" :key="entry.key">
												<span class="source-picker-artwork">
													<span class="source-artwork-placeholder">
														<Layers3 v-if="entry.group" :size="20" />
														<Asterisk v-else :size="20" />
													</span>
													<img
														v-if="entry.group?.artworkUrl || entry.item?.artworkUrl"
														:src="
															artworkVariantUrl(
																entry.group?.artworkUrl ?? entry.item?.artworkUrl,
																'thumb',
															)
														"
														:srcset="
															artworkSrcset(
																entry.group?.artworkUrl ?? entry.item?.artworkUrl,
																'thumb',
															)
														"
														:alt="`${entry.group?.title ?? entry.item?.title} artwork`"
														loading="eager"
														decoding="async"
														@error="hideBrokenImage"
													/>
												</span>
												<span class="source-picker-copy">
													<strong>{{ entry.group?.title ?? entry.item?.title }}</strong>
													<small>{{ sourceEntrySubtitle(entry) }}</small>
													<small v-if="sourceMatchText(entry)" class="source-match-context">
														Matched {{ sourceMatchText(entry) }}
													</small>
												</span>
												<div class="source-picker-actions">
													<button
														v-if="entry.group && entry.group.childCount > 0"
														type="button"
														class="text-button"
														@click="browseGroup(entry)"
													>
														Browse</button
													><button
														v-if="
															(form.sourceType === 'group' && entry.group) ||
																(form.sourceType === 'item' && entry.item)
														"
														type="button"
														class="text-button"
														@click="selectSource(entry)"
													>
														Select
													</button>
													<button
														v-if="form.sourceType === 'collection' && entry.item"
														type="button"
														class="source-selection-button"
														:class="{ selected: selectedIdSet.has(entry.item.id) }"
														@click="toggleSelectedItem(entry.item)"
													>
														<X v-if="selectedIdSet.has(entry.item.id)" :size="14" />
														<Plus v-else :size="14" />
														{{ selectedIdSet.has(entry.item.id) ? 'Remove' : 'Add' }}
													</button>
													<button
														v-if="form.sourceType === 'group-collection' && entry.group"
														type="button"
														class="source-selection-button"
														:class="{ selected: selectedGroupIdSet.has(entry.group.id) }"
														@click="toggleSelectedGroup(entry.group)"
													>
														<X v-if="selectedGroupIdSet.has(entry.group.id)" :size="14" />
														<Plus v-else :size="14" />
														{{ selectedGroupIdSet.has(entry.group.id) ? 'Remove' : 'Add' }}
													</button>
												</div>
											</article>
										</div>
										<div v-else-if="sourceLoaded" class="empty-state compact">
											<p>No matching source media.</p>
										</div>
										<div v-if="sourceTotalPages > 1" class="source-picker-pagination">
											<button
												type="button"
												class="toolbar-button"
												:disabled="sourcePage <= 1"
												@click="changeSourcePage(sourcePage - 1)"
											>
												Previous
											</button>
											<small>Page {{ sourcePage }} of {{ sourceTotalPages }}</small>
											<button
												type="button"
												class="toolbar-button"
												:disabled="sourcePage >= sourceTotalPages"
												@click="changeSourcePage(sourcePage + 1)"
											>
												Next
											</button>
										</div>
									</template>
								</div>
							</section>
							<SelectionStrategyEditor v-model="form.strategy" v-model:seed="form.seed" />
						</template>

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
					</div>
				</div>
				<footer class="program-editor-actions">
					<button type="button" class="toolbar-button" @click="closeEditor">Cancel</button>
					<div>
						<button
							v-if="!editingId"
							type="button"
							class="button ghost"
							:disabled="saving"
							@click="save(true)"
						>
							Save and add another
						</button>
						<button type="submit" class="button" :disabled="saving">
							<Check v-if="!saving" :size="18" />
							{{ saving ? 'Saving…' : editingId ? 'Save changes' : 'Save ' + form.type + ' rule' }}
						</button>
					</div>
				</footer>
			</form>
		</div>
		<MediaSelectionDrawer
			v-if="selectionDrawerOpen"
			:selecting-groups="selectingGroups"
			:selection-count="selectionCount"
			:selection-limit="selectionLimit"
			:loading="selectionLoading"
			:loaded="selectionLoaded"
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
			@update:search="selectedItemSearch = $event"
			@close="closeSelectionDrawer"
			@clear="clearSelectedItems"
			@remove-item="removeSelectedItem"
			@remove-group="removeSelectedGroup"
		/>
	</section>
</template>
