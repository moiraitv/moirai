<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type {
	CatalogProgramItemFilter,
	LibraryQuerySort,
	MediaGenreFacet,
} from '@moirai/shared';
import type { QuickChannelQueryPreviewResult } from '@moirai/shared/api-contracts';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import LibraryQueryFilter from '../library/LibraryQueryFilter.vue';
import QuickQueryPreview from '../quick/QuickQueryPreview.vue';

const props = defineProps<{
	libraryId: string;
	libraryType: string;
	genres: MediaGenreFacet[];
	loading: boolean;
	loaded: boolean;
	refreshRevision: number;
}>();
const filter = defineModel<CatalogProgramItemFilter>({ required: true });
const sort = defineModel<LibraryQuerySort>('sort', { required: true });
const itemLimit = defineModel<number | null>('itemLimit', { required: true });
const items = ref<QuickChannelQueryPreviewResult['items']>([]);
const indexedItemCount = ref(0);
const previewLoading = ref(false);
const loadingMore = ref(false);
const previewLoaded = ref(false);
const error = ref('');
const cursor = ref<string | null>(null);
let loadSequence = 0;

/** Refresh the loaded range in place, resetting only for authored query changes. */
async function loadPreview(background = false): Promise<void> {
	const sequence = ++loadSequence;
	previewLoading.value = true;
	loadingMore.value = false;
	error.value = '';
	if (!background) {
		previewLoaded.value = false;
		items.value = [];
		indexedItemCount.value = 0;
		cursor.value = null;
	}
	if (!props.libraryId) {
		previewLoading.value = false;
		previewLoaded.value = true;
		return;
	}

	try {
		const targetCount = background ? Math.max(24, items.value.length) : 24;
		const nextItems: QuickChannelQueryPreviewResult['items'] = [];
		let nextCursor: string | null = null;
		let nextCount = 0;
		do {
			const result = await api.previewQuickChannelQuery({
				scenario: props.libraryType,
				libraryId: props.libraryId,
				...filter.value,
				sort: sort.value,
				itemLimit: itemLimit.value,
				cursor: nextCursor,
				limit: Math.min(48, Math.max(24, targetCount - nextItems.length)),
			});
			if (sequence !== loadSequence) {
				return;
			}

			nextItems.push(...result.items);
			nextCount = result.indexedItemCount;
			nextCursor = result.nextCursor;
		} while (nextCursor !== null && nextItems.length < targetCount);

		items.value = nextItems;
		indexedItemCount.value = nextCount;
		cursor.value = nextCursor;
		previewLoaded.value = true;
	}
	catch (cause) {
		if (sequence === loadSequence) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === loadSequence) {
			previewLoading.value = false;
		}
	}
}

/** Append the next stable cursor page as the virtual carousel approaches its loaded edge. */
async function loadMore(): Promise<void> {
	if (previewLoading.value || loadingMore.value || !cursor.value) {
		return;
	}

	const sequence = ++loadSequence;
	loadingMore.value = true;
	try {
		const result = await api.previewQuickChannelQuery({
			scenario: props.libraryType,
			libraryId: props.libraryId,
			...filter.value,
			sort: sort.value,
			itemLimit: itemLimit.value,
			cursor: cursor.value,
			limit: 24,
		});
		if (sequence !== loadSequence) {
			return;
		}

		const loadedIds = new Set(items.value.map((item) => item.id));
		items.value.push(...result.items.filter((item) => !loadedIds.has(item.id)));
		indexedItemCount.value = result.indexedItemCount;
		cursor.value = result.nextCursor;
		error.value = '';
	}
	catch (cause) {
		if (sequence === loadSequence) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === loadSequence) {
			loadingMore.value = false;
		}
	}
}

watch(
	() => JSON.stringify([
		props.libraryId,
		filter.value,
		sort.value,
		itemLimit.value,
	]),
	() => void loadPreview(),
);
watch(() => props.refreshRevision, () => void loadPreview(true));
onMounted(() => void loadPreview());
</script>

<template>
	<div class="program-library-query">
		<LibraryQueryFilter
			v-model="filter"
			v-model:sort="sort"
			v-model:item-limit="itemLimit"
			:library-id="libraryId"
			:genres="genres"
			:loading="props.loading"
			:loaded="props.loaded"
		/>
		<QuickQueryPreview
			:items="items"
			:indexed-item-count="indexedItemCount"
			:loading="previewLoading"
			:loading-more="loadingMore"
			:loaded="previewLoaded"
			:has-more="cursor !== null"
			:error="error"
			@retry="loadPreview(true)"
			@load-more="loadMore"
		/>
	</div>
</template>
