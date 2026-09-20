<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { MAX_SIMILARITY_QUANTITY, semanticProgramConfigSchema } from '@moirai/shared';
import { api } from '../../api';
import { useSimilarityPreview } from './use-similarity-preview';
import { errorMessage } from '../../error-message';
import TransientToast from '../TransientToast.vue';
import SimilarityLibraryFilters from './SimilarityLibraryFilters.vue';
import LibraryQueryFilter from '../library/LibraryQueryFilter.vue';
import { emptyCatalogProgramItemFilter } from '../library/library-filter';
import SimilarItemsPreview from './SimilarItemsPreview.vue';
import type { CatalogProgramItemFilter, MediaGenreFacet, SchedulingProgram, SchedulingProgramStatus } from '@moirai/shared';

const props = defineProps<{ programs: SchedulingProgram[]; status?: SchedulingProgramStatus | undefined; readOnlySource?: boolean; type: 'similarity' | 'theme'; libraries: { id: string; name: string; typeKey: string }[]; genres: MediaGenreFacet[]; filtersLoading: boolean; filtersLoaded: boolean }>();
const filter = defineModel<CatalogProgramItemFilter>('filter', { required: true });
const theme = defineModel<string>('theme', { required: true });
const libraryId = defineModel<string>('libraryId', { required: true });
const sourceProgramId = defineModel<string>('sourceProgramId', { required: true });
const variety = defineModel<number>('variety', { required: true });
const quantity = defineModel<number>('quantity', { required: true });
const softPreferences = defineModel<string>('softPreferences', { required: true });
const exclusionStrictness = defineModel<number>('exclusionStrictness', { required: true });
const exclusionText = defineModel<string>('exclusionText', { required: true });
const hardExclusions = computed(() => exclusionText.value.split(',').map((text) => text.trim()).filter(Boolean));
const sources = computed(() => props.programs.filter((program) =>
	program.config.type === 'content' && program.config.source.type === 'collection'));
const sourceLibraryId = computed(() => {
	const source = sources.value.find((program) => program.id === sourceProgramId.value)?.config;
	return source?.type === 'content' && source.source.type === 'collection' ? source.source.libraryId : '';
});
const retryError = ref('');
const retrying = ref(false);
const retryNotice = ref('');
const draftConfig = computed(() => semanticProgramConfigSchema.safeParse({ ...(props.type === 'theme' ? { type: 'theme', libraryId: libraryId.value, theme: theme.value, filter: filter.value } : { type: 'similarity', sourceProgramId: sourceProgramId.value, filter: filter.value }),
	variety: variety.value, quantity: quantity.value, softPreferences: softPreferences.value,
	hardExclusions: hardExclusions.value, exclusionStrictness: exclusionStrictness.value }));
const { preview, loading, error, refresh } = useSimilarityPreview(
	() => draftConfig.value.success ? draftConfig.value.data : null,
	() => JSON.stringify([theme.value, softPreferences.value, exclusionText.value]),
	() => props.programs.find((program) => program.id === sourceProgramId.value)?.config,
);
watch(draftConfig, () => {
	retryError.value = '';
});
/** Retry only failed embeddings for this draft, preserving ready vectors and active sets. */
async function retryEmbeddings(): Promise<void> {
	const config = semanticProgramConfigSchema.safeParse({ ...(props.type === 'theme' ? { type: 'theme', libraryId: libraryId.value, theme: theme.value, filter: filter.value } : { type: 'similarity', sourceProgramId: sourceProgramId.value, filter: filter.value }),
		variety: variety.value, quantity: quantity.value, softPreferences: softPreferences.value,
		hardExclusions: hardExclusions.value, exclusionStrictness: exclusionStrictness.value });
	if (!config.success || retrying.value) {
		return;
	}
	retrying.value = true;
	retryError.value = '';
	try {
		const result = await api.retrySimilarityEmbeddings(config.data);
		retryNotice.value = result.queued ? `${result.queued} preparation ${result.queued === 1 ? 'task' : 'tasks'} queued for retry.` : 'No failed preparation tasks need retrying.';
		refresh();
	}
	catch (cause) {
		retryError.value = errorMessage(cause);
	}
	finally {
		retrying.value = false;
	}
}

</script>

<template>
	<section class="program-editor-section">
		<div class="program-section-heading">
			<span>1</span>
			<div class="program-section-heading-copy">
				<strong>{{ type === 'theme' ? 'Theme selection' : 'Similar item selection' }}</strong>
				<p class="program-section-description">{{ type === 'theme' ? 'Describe a theme and find matching media in a library.' : 'Choose a source and refine related matches.' }}</p>
			</div>
		</div>
		<p v-for="set in status?.currentSets ?? []" :key="set.consumerKey" class="muted">{{ set.channelName ?? 'Schedule use' }} · set {{ set.generation }}: {{ set.remaining }} of {{ set.total }} remaining for this schedule use.<span v-if="set.requestedTotal && set.total < set.requestedTotal"> This set has {{ set.total }} matches; requested {{ set.requestedTotal }}.</span></p>
		<label v-if="type === 'theme'"><span>Target library</span>
			<select v-model="libraryId" required aria-label="Target library" @change="filter = emptyCatalogProgramItemFilter()">
				<option disabled value="">Select a library</option>
				<option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option>
			</select>
		</label>
		<LibraryQueryFilter
			v-if="type === 'theme'" v-model="filter" class="similarity-library-filter" :library-id="libraryId"
			:library-type="libraries.find((library) => library.id === libraryId)?.typeKey" :genres="genres"
			:loading="filtersLoading" :loaded="filtersLoaded" :show-ordering="false" />
		<label v-if="type === 'theme'" class="similarity-theme"><span>Theme</span>
			<textarea v-model="theme" required rows="3" maxlength="500" placeholder="e.g., Space exploration and first contact" aria-label="Theme" />
			<small>Describe what this Program should play. Matches use available media metadata.</small>
		</label>
		<label v-if="type === 'similarity'"><span>Source Program</span>
			<input v-if="readOnlySource" :value="programs.find((program) => program.id === sourceProgramId)?.name ?? 'Missing source Program'" readonly aria-label="Source Program" />
			<select v-else v-model="sourceProgramId" required aria-label="Source Program" @change="filter = emptyCatalogProgramItemFilter()">
				<option disabled value="">Select a Specific media items Program</option>
				<option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option>
			</select>
			<small v-if="sources.length === 0">Create a Content Program with Specific media items first.</small>
		</label>
		<SimilarityLibraryFilters
			v-if="type === 'similarity'" v-model="filter" :library-id="sourceLibraryId"
			:library-type="libraries.find((library) => library.id === sourceLibraryId)?.typeKey" />
		<div class="similarity-settings">
			<div class="similarity-source-settings">
				<label><span>Quantity</span>
					<input v-model.number="quantity" required type="number" min="1" :max="MAX_SIMILARITY_QUANTITY" step="1" aria-label="Quantity" />
					<small>Number of items selected before a new set is generated.</small>
				</label>
			</div>
			<label><span>Cohesion / Variety · {{ variety }}</span>
				<input v-model.number="variety" type="range" min="0" max="100" step="1" aria-label="Cohesion / Variety" />
				<span class="similarity-range-labels"><span>Cohesive</span><span>Varied</span></span>
				<small>Stay tightly related to the source or theme or explore more varied but still related content.</small>
			</label>
		</div>
		<div class="similarity-refinements">
			<label><span>Preferences</span>
				<textarea v-model="softPreferences" rows="3" maxlength="500" placeholder="e.g., Darker, slower-paced science fiction" aria-label="Preferences" />
				<small>Favor these themes while keeping matches related to the source or theme.</small>
			</label>
			<div class="similarity-source-settings">
				<label><span>Exclusions</span>
					<textarea v-model="exclusionText" rows="3" placeholder="e.g., superhero movies, romantic comedies" aria-label="Exclusions" />
					<small>Comma-separated concepts to avoid. Use “superhero movies,” not “no superhero movies.” Matches are approximate; review the excluded sample below.</small>
				</label>
				<label v-if="hardExclusions.length"><span>Exclusion strictness · {{ exclusionStrictness }}</span>
					<input v-model.number="exclusionStrictness" type="range" min="0" max="100" step="1" aria-label="Exclusion strictness" />
					<span class="similarity-range-labels"><span>Close matches</span><span>Broader matches</span></span>
				</label>
			</div>
		</div>
		<SimilarItemsPreview
			v-if="loading || error || preview" :items="preview?.previewItems ?? []" presentation="editor"
			:matching-count="preview?.matchingItemCount" :requested-count="preview?.requestedItemCount"
			:loading="!error && (loading || Boolean(preview?.previewPending))" :error="Boolean(error)"
			:message="error || (loading ? 'Finding sample matches…' : preview?.health !== 'ready' ? preview?.sourceLabel : undefined)" />
		<SimilarItemsPreview v-if="!loading && !error && hardExclusions.length && preview?.excludedPreviewItems" :items="preview.excludedPreviewItems" presentation="editor" heading="Excluded matches" empty-message="No ready candidates match the exclusion concepts at this strictness." />
		<button v-if="(preview?.failedEmbeddingCount ?? 0) > 0" type="button" class="secondary" :disabled="loading || retrying" @click="retryEmbeddings">{{ retrying ? 'Queueing retry…' : 'Retry preparation' }}</button>
		<p v-if="retryError" class="notice" role="alert">{{ retryError }}</p>
		<TransientToast v-if="retryNotice" :message="retryNotice" @close="retryNotice = ''" />
	</section>
</template>
