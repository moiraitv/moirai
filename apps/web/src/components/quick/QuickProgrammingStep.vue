<script setup lang="ts">
import QuickStepActions from './QuickStepActions.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { ChevronDown, ChevronUp, GripVertical, Trash2 } from '@lucide/vue';
import { VueDraggable } from 'vue-draggable-plus';
import type {
	MediaGroup,
	MediaGenreFacet,
	MediaItem,
	MediaSourcePickerEntry,
	QuickChannelScenario,
} from '@moirai/shared';
import { MAX_EXPLICIT_MEDIA_GROUPS, MAX_LIBRARY_QUERY_ITEMS } from '@moirai/shared';
import type { QuickChannelQueryPreviewResult } from '@moirai/shared/api-contracts';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import type { QuickProgrammingDraft } from '../../quick-setup';
import LibraryQueryFilter from '../library/LibraryQueryFilter.vue';
import ProgramSourceBrowser from '../programs/ProgramSourceBrowser.vue';
import SelectionStrategyEditor from '../programs/SelectionStrategyEditor.vue';
import QuickQueryPreview from './QuickQueryPreview.vue';
import TwoStepActionButton from '../TwoStepActionButton.vue';

const props = defineProps<{
	scenario: QuickChannelScenario;
	libraryId: string;
	libraryName: string;
	libraryScanning: boolean;
	itemLimit: number;
	refreshRevision: number;
}>();
const draft = defineModel<QuickProgrammingDraft>({ required: true });
const emit = defineEmits<{ back: []; next: [] }>();
const error = ref('');
const entries = ref<MediaSourcePickerEntry[]>([]);
const loading = ref(false);
const loaded = ref(false);
const parentId = ref<string>();
const page = ref(1);
const totalPages = ref(1);
const search = ref('');
const browserOpen = ref(true);
const genres = ref<MediaGenreFacet[]>([]);
const queryPreviewItems = ref<QuickChannelQueryPreviewResult['items']>([]);
const queryPreviewCount = ref(0);
const queryPreviewLoading = ref(false);
const queryPreviewLoadingMore = ref(false);
const queryPreviewLoaded = ref(false);
const queryPreviewError = ref('');
const queryPreviewCursor = ref<string | null>(null);
let loadSequence = 0;
let queryPreviewSequence = 0;
const selectedIds = computed(() => new Set(draft.value.items.map((item) => item.id)));
const selectedGroupIds = computed(() => new Set(draft.value.groups.map((group) => group.id)));
const selectionCount = computed(() => draft.value.sourceType === 'collection'
	? draft.value.items.length
	: draft.value.sourceType === 'group-collection' ? draft.value.groups.length : 0);
const queryLimitValid = computed(() => draft.value.sourceType !== 'library-query'
	|| draft.value.queryItemLimit === null
	|| (
		Number.isInteger(draft.value.queryItemLimit)
		&& draft.value.queryItemLimit >= 1
		&& draft.value.queryItemLimit <= MAX_LIBRARY_QUERY_ITEMS
	));
const canContinue = computed(() => draft.value.name.trim().length > 0
	&& queryLimitValid.value
	&& (draft.value.sourceType === 'library-query' || selectionCount.value > 0));

/** Load genre facets or explicit source choices, optionally preserving the visible page while refreshing. */
async function loadOptions(background = false): Promise<void> {
	const sequence = ++loadSequence;
	if (!background) {
		loading.value = true;
		loaded.value = false;
		error.value = '';
	}
	try {
		if (draft.value.sourceType === 'library-query') {
			const nextGenres = await api.mediaGenres(props.libraryId);
			if (sequence !== loadSequence) {
				return;
			}

			genres.value = nextGenres;
			entries.value = [];
			page.value = 1;
			totalPages.value = 1;
		}
		else {
			const result = await api.mediaSourceOptions(props.libraryId, {
				target: draft.value.sourceType === 'group-collection' ? 'groups' : 'items',
				...(parentId.value ? { parentId: parentId.value } : {}),
				page: page.value,
				pageSize: 20,
				search: search.value,
			});
			if (sequence !== loadSequence) {
				return;
			}
			if (!background || JSON.stringify(entries.value) !== JSON.stringify(result.entries)) {
				entries.value = result.entries;
			}
			page.value = result.pagination.page;
			totalPages.value = result.pagination.totalPages;
		}
		loaded.value = true;
	}
	catch (cause) {
		if (sequence === loadSequence && !background) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === loadSequence) {
			loading.value = false;
		}
	}
}

/** Replace loaded query matches, retaining the visible range during background scan refreshes. */
async function loadQueryPreview(background = false): Promise<void> {
	const sequence = ++queryPreviewSequence;
	queryPreviewLoadingMore.value = false;
	if (!background) {
		queryPreviewLoading.value = true;
		queryPreviewLoaded.value = false;
		queryPreviewError.value = '';
		queryPreviewItems.value = [];
		queryPreviewCount.value = 0;
		queryPreviewCursor.value = null;
	}
	try {
		const targetCount = background ? Math.max(24, queryPreviewItems.value.length) : 24;
		const nextItems: QuickChannelQueryPreviewResult['items'] = [];
		let cursor: string | null = null;
		let indexedItemCount = 0;
		do {
			const result = await api.previewQuickChannelQuery({
				scenario: props.scenario,
				libraryId: props.libraryId,
				...draft.value.filter,
				sort: draft.value.querySort,
				itemLimit: draft.value.queryItemLimit,
				cursor,
				limit: Math.min(48, Math.max(24, targetCount - nextItems.length)),
			});
			if (sequence !== queryPreviewSequence) {
				return;
			}

			nextItems.push(...result.items);
			indexedItemCount = result.indexedItemCount;
			cursor = result.nextCursor;
		} while (cursor !== null && nextItems.length < targetCount);

		queryPreviewItems.value = nextItems;
		queryPreviewCount.value = indexedItemCount;
		queryPreviewCursor.value = cursor;
		queryPreviewLoaded.value = true;
		queryPreviewError.value = '';
	}
	catch (cause) {
		if (sequence === queryPreviewSequence && !background) {
			queryPreviewError.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === queryPreviewSequence) {
			queryPreviewLoading.value = false;
		}
	}
}

/** Append the next cursor page when the virtual carousel approaches its loaded edge. */
async function loadMoreQueryPreview(): Promise<void> {
	if (queryPreviewLoading.value || queryPreviewLoadingMore.value || !queryPreviewCursor.value) {
		return;
	}

	const sequence = ++queryPreviewSequence;
	queryPreviewLoadingMore.value = true;
	try {
		const result = await api.previewQuickChannelQuery({
			scenario: props.scenario,
			libraryId: props.libraryId,
			...draft.value.filter,
			sort: draft.value.querySort,
			itemLimit: draft.value.queryItemLimit,
			cursor: queryPreviewCursor.value,
			limit: 24,
		});
		if (sequence !== queryPreviewSequence) {
			return;
		}

		const loadedIds = new Set(queryPreviewItems.value.map((item) => item.id));
		queryPreviewItems.value = [
			...queryPreviewItems.value,
			...result.items.filter((item) => !loadedIds.has(item.id)),
		];
		queryPreviewCount.value = result.indexedItemCount;
		queryPreviewCursor.value = result.nextCursor;
		queryPreviewError.value = '';
	}
	catch (cause) {
		if (sequence === queryPreviewSequence) {
			queryPreviewError.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === queryPreviewSequence) {
			queryPreviewLoadingMore.value = false;
		}
	}
}

/** Reset browsing state when the selected source mode changes. */
function changeSourceType(): void {
	parentId.value = undefined;
	page.value = 1;
	search.value = '';
	void loadOptions();
	if (draft.value.sourceType === 'library-query') {
		void loadQueryPreview();
	}
}

/** Open a hierarchy group while choosing explicit media. */
function browse(entry: MediaSourcePickerEntry): void {
	if (entry.group) {
		parentId.value = entry.group.id;
		page.value = 1;
		void loadOptions();
	}
}

/** Toggle one explicit item while preserving authored selection order. */
function toggleItem(item: MediaItem): void {
	const index = draft.value.items.findIndex((candidate) => candidate.id === item.id);
	if (index >= 0) {
		draft.value.items.splice(index, 1);
	}
	else if (draft.value.items.length < props.itemLimit) {
		draft.value.items.push(item);
	}
	else {
		error.value = `Select at most ${props.itemLimit.toLocaleString()} items.`;
	}
}

/** Toggle one show or season while enforcing the shared selection limit. */
function toggleGroup(group: MediaGroup): void {
	const index = draft.value.groups.findIndex((candidate) => candidate.id === group.id);
	if (index >= 0) {
		draft.value.groups.splice(index, 1);
	}
	else if (draft.value.groups.length < MAX_EXPLICIT_MEDIA_GROUPS) {
		draft.value.groups.push(group);
	}
	else {
		error.value = `Select at most ${MAX_EXPLICIT_MEDIA_GROUPS.toLocaleString()} shows or seasons.`;
	}
}

/** Move a selected item for keyboard-accessible manual ordering. */
function moveItem(index: number, offset: -1 | 1): void {
	const target = index + offset;
	if (target < 0 || target >= draft.value.items.length) {
		return;
	}
	const [item] = draft.value.items.splice(index, 1);
	draft.value.items.splice(target, 0, item!);
}

watch(() => props.libraryId, () => {
	void loadOptions();
	if (draft.value.sourceType === 'library-query') {
		void loadQueryPreview();
	}
});
watch(() => JSON.stringify(draft.value.filter), () => {
	if (draft.value.sourceType === 'library-query') {
		void loadQueryPreview();
	}
});
watch(() => JSON.stringify([draft.value.querySort, draft.value.queryItemLimit]), () => {
	if (draft.value.sourceType === 'library-query') {
		void loadQueryPreview();
	}
});
watch(() => props.refreshRevision, () => {
	void loadOptions(true);
	if (draft.value.sourceType === 'library-query') {
		void loadQueryPreview(true);
	}
});
onMounted(() => {
	void loadOptions();
	if (draft.value.sourceType === 'library-query') {
		void loadQueryPreview();
	}
});
</script>

<template>
	<section class="quick-step" aria-labelledby="quick-programming-title">
		<div class="quick-step-heading">
			<p class="eyebrow">Step 2 of 4</p>
			<div class="quick-programming-title-row">
				<h2 id="quick-programming-title">Choose the programming</h2>
				<span v-if="libraryScanning" class="quick-scan-badge" role="status" title="The library is still scanning. A library query can continue now; specific choices refresh as media is indexed." aria-label="The library is still scanning. A library query can continue now; specific choices refresh as media is indexed.">Library scanning</span>
			</div>
			<p>Build one reusable program from {{ libraryName }}.</p>
		</div>
		<div class="panel form-grid">
			<label class="span-2"><span>Program name</span><input v-model="draft.name" required autocapitalize="words" /></label>
			<label class="span-2">
				<span>Media choice</span>
				<select v-model="draft.sourceType" @change="changeSourceType">
					<option value="library-query">Library query</option>
					<option value="collection">Specific items</option>
					<option v-if="scenario === 'shows'" value="group-collection">Shows or seasons</option>
				</select>
			</label>
			<div v-if="draft.sourceType === 'library-query'" class="span-2 quick-genre-field">
				<LibraryQueryFilter
					v-model="draft.filter"
					v-model:sort="draft.querySort"
					v-model:item-limit="draft.queryItemLimit"
					:library-id="libraryId"
					:genres="genres"
					:loading="loading"
					:loaded="loaded"
				/>
				<QuickQueryPreview
					:items="queryPreviewItems"
					:indexed-item-count="queryPreviewCount"
					:loading="queryPreviewLoading"
					:loaded="queryPreviewLoaded"
					:error="queryPreviewError"
					:has-more="queryPreviewCursor !== null"
					:loading-more="queryPreviewLoadingMore"
					@retry="queryPreviewItems.length ? loadMoreQueryPreview() : loadQueryPreview()"
					@load-more="loadMoreQueryPreview"
				/>
			</div>
			<ProgramSourceBrowser
				v-else
				v-model:open="browserOpen"
				v-model:search="search"
				class="span-2"
				:source-type="draft.sourceType"
				:library-type="scenario"
				:source-entries="entries"
				:source-loading="loading"
				:source-loaded="loaded"
				:source-parent-id="parentId"
				:source-page="page"
				:source-total-pages="totalPages"
				:selected-id-set="selectedIds"
				:selected-group-id-set="selectedGroupIds"
				@search="page = 1; loadOptions()"
				@root="parentId = undefined; page = 1; loadOptions()"
				@browse="browse"
				@select="() => undefined"
				@toggle-item="toggleItem"
				@toggle-group="toggleGroup"
				@page="page = $event; loadOptions()"
			/>
		</div>
		<div v-if="draft.sourceType === 'collection' && draft.items.length" class="quick-selection-review panel">
			<h3>Selected items <small>{{ draft.items.length.toLocaleString() }}</small></h3>
			<p>Drag items or use the arrow buttons to set the sequential order.</p>
			<VueDraggable v-model="draft.items" handle=".quick-drag" :animation="160" class="quick-selected-list">
				<article v-for="(item, index) in draft.items" :key="item.id">
					<button type="button" class="quick-drag" :aria-label="`Drag ${item.title} to reorder`"><GripVertical :size="16" /></button>
					<span><strong>{{ item.title }}</strong><small>{{ item.year ?? item.kind }}</small></span>
					<button type="button" :disabled="index === 0" :aria-label="`Move ${item.title} earlier`" @click="moveItem(index, -1)"><ChevronUp :size="15" /></button>
					<button type="button" :disabled="index === draft.items.length - 1" :aria-label="`Move ${item.title} later`" @click="moveItem(index, 1)"><ChevronDown :size="15" /></button>
					<TwoStepActionButton :label="`Remove ${item.title}`" :confirm-label="`Confirm remove ${item.title}`" @confirm="draft.items.splice(index, 1)"><Trash2 :size="15" /></TwoStepActionButton>
				</article>
			</VueDraggable>
		</div>
		<div v-if="draft.sourceType === 'group-collection' && draft.groups.length" class="quick-selection-review panel">
			<h3>Selected shows and seasons <small>{{ draft.groups.length.toLocaleString() }}</small></h3>
			<div class="quick-selected-list">
				<article v-for="(group, index) in draft.groups" :key="group.id">
					<span><strong>{{ group.title }}</strong><small>{{ group.kind }}</small></span>
					<TwoStepActionButton :label="`Remove ${group.title}`" :confirm-label="`Confirm remove ${group.title}`" @confirm="draft.groups.splice(index, 1)"><Trash2 :size="15" /></TwoStepActionButton>
				</article>
			</div>
		</div>
		<p v-if="error" class="notice error">{{ error }}</p>
		<SelectionStrategyEditor
			v-model="draft.strategy"
			v-model:seed="draft.seed"
			:show-seed="false"
			:show-playback-state="false"
		/>
		<QuickStepActions>
			<button class="button secondary" type="button" @click="emit('back')">Back</button>
			<button class="button" type="button" :disabled="!canContinue" @click="emit('next')">Continue</button>
		</QuickStepActions>
	</section>
</template>
