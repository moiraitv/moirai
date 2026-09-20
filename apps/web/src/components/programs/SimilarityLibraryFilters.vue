<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CatalogProgramItemFilter, MediaGenreFacet } from '@moirai/shared';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import LibraryQueryFilter from '../library/LibraryQueryFilter.vue';
import { catalogProgramItemFilterSummary } from '../library/library-filter';

const props = defineProps<{ libraryId: string; libraryType?: string | undefined }>();
const filter = defineModel<CatalogProgramItemFilter>({ required: true });
const expanded = ref(false);
const genres = ref<MediaGenreFacet[]>([]);
const loading = ref(false);
const loaded = ref(false);
const error = ref('');
let loadSequence = 0;
const summary = computed(() => catalogProgramItemFilterSummary(
	filter.value,
	new Map(genres.value.map((genre) => [genre.key, genre.name])),
).join(' · ') || 'No additional restrictions');

/** Load filter choices only when requested, ignoring responses from a previous source library. */
async function loadGenres(): Promise<void> {
	const sequence = ++loadSequence;
	loading.value = true;
	error.value = '';
	try {
		const result = await api.mediaGenres(props.libraryId);
		if (sequence === loadSequence) {
			genres.value = result;
			loaded.value = true;
		}
	}
	catch (cause) {
		if (sequence === loadSequence) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === loadSequence) {
			loading.value = false;
		}
	}
}

watch(() => props.libraryId, () => {
	loadSequence += 1;
	genres.value = [];
	loaded.value = false;
	loading.value = false;
	error.value = '';
});
watch(() => [expanded.value, props.libraryId], () => {
	if (expanded.value && props.libraryId && !loaded.value) {
		void loadGenres();
	}
});
</script>

<template>
	<details class="similarity-library-filters" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
		<summary><span>Additional filters <small>Optional</small></span><small>{{ summary }}</small></summary>
		<div v-if="expanded" class="similarity-library-filters-content">
			<p v-if="!libraryId" class="muted">Choose a Source Program to configure filters.</p>
			<template v-else>
				<LibraryQueryFilter
					v-model="filter" :library-id="libraryId" :library-type="libraryType"
					:genres="genres" :loading="loading" :loaded="loaded" :show-ordering="false" />
				<p class="muted">Filters apply to matches. Source items still guide similarity.</p>
				<p v-if="error" class="notice" role="alert">{{ error }}</p>
				<button v-if="error" type="button" class="secondary" :disabled="loading" @click="loadGenres">Retry loading filters</button>
			</template>
		</div>
	</details>
</template>
