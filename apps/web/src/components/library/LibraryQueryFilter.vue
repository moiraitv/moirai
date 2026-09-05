<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { Filter } from '@lucide/vue';
import {
	MAX_LIBRARY_QUERY_ITEMS,
	type CatalogProgramItemFilter,
	type LibraryQuerySort,
	type MediaGenreFacet,
} from '@moirai/shared';
import LibraryFilterModal from './LibraryFilterModal.vue';
import {
	catalogProgramItemFilterSummary,
	catalogProgramItemFilter,
	libraryFilterDraft,
	type LibraryFilterDraft,
} from './library-filter';

const props = defineProps<{
	libraryId: string;
	genres: MediaGenreFacet[];
	loading: boolean;
	loaded: boolean;
}>();
const filter = defineModel<CatalogProgramItemFilter>({ required: true });
const sort = defineModel<LibraryQuerySort>('sort', { required: true });
const itemLimit = defineModel<number | null>('itemLimit', { required: true });
const modalOpen = ref(false);
const configureButton = ref<HTMLButtonElement>();
const filterSummary = computed(() => catalogProgramItemFilterSummary(
	filter.value,
	new Map(props.genres.map((genre) => [genre.key, genre.name])),
));
const visibleFilterSummary = computed(() => filterSummary.value.slice(0, 4));
const hiddenFilterCount = computed(() => filterSummary.value.length - visibleFilterSummary.value.length);
const draft = computed(() => libraryFilterDraft(filter.value));

/** Commit the shared Filter Library controls to the owning dynamic program draft. */
function applyFilters(nextDraft: LibraryFilterDraft): void {
	filter.value = catalogProgramItemFilter(nextDraft);
	void closeFilters();
}

/** Return keyboard focus to the invoking control after the nested filter dialog is removed. */
async function closeFilters(): Promise<void> {
	modalOpen.value = false;
	await nextTick();
	configureButton.value?.focus();
}

/** Retain a blank limit as All while exposing positive integers to the query contract. */
function updateItemLimit(event: Event): void {
	const value = (event.target as HTMLInputElement).value;
	itemLimit.value = value === '' ? null : Number(value);
}
</script>

<template>
	<div class="library-query-filter">
		<div class="library-query-filter-main">
			<div class="library-query-filter-copy">
				<strong>Query parameters</strong>
				<small v-if="loading && !loaded">Loading available filters…</small>
				<div v-else-if="filterSummary.length" class="library-query-filter-summary" :title="filterSummary.join(' · ')">
					<span v-for="summary in visibleFilterSummary" :key="summary">{{ summary }}</span>
					<span v-if="hiddenFilterCount" class="library-query-filter-more">+{{ hiddenFilterCount }} more</span>
				</div>
				<small v-else>All compatible media</small>
			</div>
			<button ref="configureButton" type="button" class="button secondary" :disabled="!libraryId || !loaded" @click="modalOpen = true">
				<Filter :size="16" aria-hidden="true" /> Configure Filters
			</button>
		</div>
		<div class="library-query-order">
			<label>
				<span>Order by</span>
				<select v-model="sort.type">
					<option value="name">Title / episode</option>
					<option value="date-added">Date indexed</option>
					<option value="release-date">Release date</option>
				</select>
			</label>
			<label>
				<span>Direction</span>
				<select v-model="sort.direction">
					<option value="asc">Ascending</option>
					<option value="desc">Descending</option>
				</select>
			</label>
			<label class="library-query-limit">
				<span>Limit</span>
				<input
					type="number"
					inputmode="numeric"
					min="1"
					:max="MAX_LIBRARY_QUERY_ITEMS"
					step="1"
					placeholder="All"
					:value="itemLimit ?? ''"
					@input="updateItemLimit"
				/>
			</label>
		</div>
		<Teleport to="body">
			<LibraryFilterModal
				v-if="modalOpen"
				:library-id="props.libraryId"
				:draft="draft"
				:genres="genres"
				@apply="applyFilters"
				@close="closeFilters"
			/>
		</Teleport>
	</div>
</template>
