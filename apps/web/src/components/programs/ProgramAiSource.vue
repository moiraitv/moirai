<script setup lang="ts">
import { AI_RESULT_COUNTS, type AiGeneration, type AiProgress, type AiProgressDetails, type AiResultCount, type AiSelectionCoverage } from '@moirai/shared';
import { computed, onScopeDispose, ref, watch } from 'vue';
import { api, ApiError } from '../../api';
import { errorMessage } from '../../error-message';
import { randomUuid } from '../../random-uuid';

const prompt = defineModel<string>('prompt', { required: true });
const selectionPrompt = defineModel<string | null>('selectionPrompt', { required: true });
const maxResults = defineModel<AiResultCount>('maxResults', { required: true });
/** Plain-language labels for the shared result-count steps. */
const resultLabels = ['Few', 'Some', 'Moderate', 'Many', 'Most'] as const;
const resultLabel = computed(() => resultLabels[AI_RESULT_COUNTS.indexOf(maxResults.value)] ?? 'Some');
const itemIds = defineModel<string[]>('itemIds', { required: true });
const generation = defineModel<string | null>('generation', { required: true });
const sortType = defineModel<'date-added' | 'name' | 'release-date' | 'manual'>('sortType', { required: true });
const sortDirection = defineModel<'asc' | 'desc'>('sortDirection', { required: true });
const props = defineProps<{ libraryId: string; draftRevision: number; sequential: boolean }>();
const generating = ref(false);
const activity = ref<AiProgress>('preparing');
const elapsed = ref(0);
const completed = ref(false);
const progressPercent = ref(0);
const elapsedLabel = computed(() => `${Math.floor(elapsed.value / 60)}:${String(elapsed.value % 60).padStart(2, '0')}`);
const coverage = ref<AiSelectionCoverage>();
const progressDetails = ref<AiProgressDetails>();
const failure = ref('');
const unmatched = ref<Array<{ title: string; year: number | null }>>([]);
const catalogTruncated = ref(false);
const activityLabel = computed(() => {
	const batch = progressDetails.value?.batch
		? ` · Batch ${progressDetails.value.batch} of ${progressDetails.value.totalBatches}` : '';
	if (batch) {
		return `${activity.value === 'searching' ? 'Searching the web' : 'Reviewing candidates'}…${batch}`;
	}
	return { generating: 'Generating…', searching: 'Searching the web…', preparing: 'Preparing candidates…',
		discovering: 'Finding candidates…', reviewing: 'Reviewing candidates…' }[activity.value];
});
let controller: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let starting = false;
let disposed = false;

/** Reserve preparation and final refinement shares around the review batches. */
function stagePercent(status: AiProgress, details: AiProgressDetails): number {
	if (details.batch && details.totalBatches) {
		return Math.min(95, Math.floor(15 + 80 * (details.batch - 1) / details.totalBatches));
	}
	if (status === 'generating') {
		return 95;
	}
	return status === 'reviewing' || status === 'searching' ? 15 : status === 'discovering' ? 5 : 0;
}

/** Disconnect this page without cancelling server-owned work. */
function disconnect(): void {
	clearTimeout(timer);
	controller?.abort();
	controller = undefined;
	generating.value = false;
}

/** Apply only a terminal result belonging to the current draft's generation identity. */
function apply(value: AiGeneration): boolean {
	activity.value = value.status;
	progressDetails.value = { ...(value.batch ? { batch: value.batch } : {}), ...(value.totalBatches ? { totalBatches: value.totalBatches } : {}) };
	progressPercent.value = Math.max(progressPercent.value, stagePercent(value.status, progressDetails.value));
	elapsed.value = Math.max(0, Math.floor((Date.now() - value.startedAt) / 1000));
	if (value.state === 'running') {
		return false;
	}
	if (value.state === 'completed' && value.result) {
		completed.value = true;
		itemIds.value = value.result.itemIds;
		selectionPrompt.value = prompt.value.trim();
		if (sortType.value === 'manual') {
			sortType.value = 'date-added';
		}
		unmatched.value = value.result.unmatched;
		catalogTruncated.value = value.result.catalogTruncated;
		coverage.value = value.result.coverage;
		failure.value = value.result.itemIds.length ? '' : 'No matches. Adjust the prompt and try again.';
	}
	else {
		failure.value = value.message ?? 'Generation failed. Try again.';
	}
	generation.value = null;
	return true;
}

/** Poll a retained job; a network failure leaves its identity available for explicit reconnect. */
async function follow(id: string): Promise<void> {
	if (disposed) {
		return;
	}
	disconnect();
	const connection = new AbortController();
	controller = connection;
	generating.value = true;
	failure.value = '';
	try {
		const value = await api.aiGeneration(id, connection.signal);
		if (connection.signal.aborted || generation.value !== id) {
			return;
		}
		if (!apply(value)) {
			timer = setTimeout(() => void follow(id), 1000);
		}
	}
	catch (cause) {
		if (!connection.signal.aborted && generation.value === id) {
			failure.value = errorMessage(cause);
			generating.value = false;
			if (cause instanceof ApiError && cause.status === 404) {
				generation.value = null;
			}
		}
	}
}

/** Save the job identity before sending a paid request, so a reload can reconnect safely. */
async function generate(): Promise<void> {
	if (generation.value) {
		void follow(generation.value);
		return;
	}
	starting = true;
	const id = randomUuid();
	generation.value = id;
	generating.value = true;
	failure.value = '';
	completed.value = false;
	progressPercent.value = 0;
	coverage.value = undefined;
	catalogTruncated.value = false;
	unmatched.value = [];
	elapsed.value = 0;
	activity.value = 'preparing';
	try {
		await api.startAiGeneration({ id, libraryId: props.libraryId, prompt: prompt.value.trim(), maxResults: maxResults.value });
		// The editor may have cancelled before this job existed; stop the job this response created.
		if (disposed || generation.value !== id) {
			void api.cancelAiGeneration(id).catch(() => {});
			return;
		}
		void follow(id);
	}
	catch (cause) {
		if (disposed || generation.value !== id) {
			void api.cancelAiGeneration(id).catch(() => {});
			return;
		}
		failure.value = errorMessage(cause);
		generating.value = false;
		if (cause instanceof ApiError) {
			generation.value = null;
		}
	}
	finally {
		starting = false;
	}
}

watch(generation, id => {
	disconnect();
	progressPercent.value = 0;
	if (id && !starting) {
		void follow(id);
	}
}, { immediate: true, flush: 'sync' });
watch(() => [props.libraryId, prompt.value, maxResults.value, props.draftRevision], (next, previous) => {
	if (next[3] !== previous[3]) {
		return;
	}
	const id = generation.value;
	generation.value = null;
	if (id) {
		void api.cancelAiGeneration(id).catch(() => {});
	}
	failure.value = '';
	completed.value = false;
	coverage.value = undefined;
	catalogTruncated.value = false;
	unmatched.value = [];
}, { flush: 'post' });
onScopeDispose(() => {
	disposed = true;
	disconnect();
});
</script>

<template>
	<div class="form-grid ai-program-source">
		<label class="span-2">
			<span>Prompt</span>
			<textarea
				v-model="prompt"
				rows="4"
				maxlength="2000"
				required
				placeholder="Describe the programs you want from this library."
			></textarea>
		</label>
		<div class="span-2 ai-result-count">
			<label for="ai-result-count">Results</label>
			<input id="ai-result-count" v-model.number="maxResults" type="range" min="50" max="250" step="50" :aria-valuetext="`${resultLabel}, about ${maxResults} results`" :disabled="generating" />
			<div class="ai-result-count-labels" aria-hidden="true">
				<span v-for="(count, index) in AI_RESULT_COUNTS" :key="count">{{ resultLabels[index] }}</span>
			</div>
			<small>This is a target. Results can range from few to many across providers and models; review any modest overage before saving.</small>
		</div>
		<div class="span-2 ai-selection-feedback">
			<div class="ai-selection-action">
				<button
					type="button"
					class="button"
					:disabled="generating || !libraryId || prompt.trim().length === 0"
					@click="generate"
				>
					{{ generation && !generating ? 'Reconnect' : 'Generate' }}
				</button>
				<div v-if="generating" class="ai-selection-progress">
					<span class="loading-spinner" aria-hidden="true"></span>
					<span role="status">{{ activityLabel }}</span>
					<span class="ai-selection-elapsed" aria-live="off">{{ progressPercent }}% estimated · {{ elapsedLabel }} elapsed</span>
				</div>
				<small v-else-if="itemIds.length > 0 || coverage" role="status"><span>{{ itemIds.length }} selected<template v-if="coverage"> · {{ coverage.reviewedCount.toLocaleString() }} of {{ coverage.libraryCount.toLocaleString() }} reviewed</template></span><template v-if="completed"> · 100%</template></small>
				<slot name="results" :generating="generating"></slot>
			</div>
			<p v-if="coverage?.queryEmbeddingsAvailable === false" class="ai-selection-warning">Some search concepts lacked local embeddings; title, plot, and metadata matching still ran.</p>
			<p v-if="coverage?.mediaEmbeddingsAvailable === false" class="ai-selection-warning">Some library items lacked local embeddings; title, plot, and metadata matching still ran.</p>
			<p v-if="coverage && coverage.queryEmbeddingsAvailable === undefined && !coverage.embeddingsAvailable" class="ai-selection-warning">Local embeddings were incomplete; title, plot, and metadata matching still ran.</p>
			<p v-if="coverage?.searchBudgetExhausted" class="ai-selection-warning">Research limit reached. Some plausible titles may remain unverified.</p>
			<p v-if="coverage?.reviewStoppedEarly" class="ai-selection-warning">Review stopped early. These matches came from completed batches; more titles may qualify.</p>
			<p v-if="coverage?.finalReviewIncomplete" class="ai-selection-warning">Final refinement did not finish. These matches came from completed reviews and may need a closer look.</p>
			<p v-if="coverage?.localDiscoveryFallback" class="ai-selection-warning">Model planning was unavailable. Local prompt matching found candidates for review; some suitable titles may have been missed.</p>
			<p v-if="catalogTruncated && !coverage" class="ai-selection-warning">Only part of this library was checked.</p>
			<p v-if="itemIds.length > 0 && selectionPrompt !== prompt.trim()" class="ai-selection-warning" role="status">{{ selectionPrompt === null ? 'These results may be from an earlier prompt.' : 'This prompt has not been generated for the current selection.' }} Save will keep the selected results.</p>
			<p v-if="failure" class="form-error" role="alert">{{ failure }}</p>
			<ul v-if="unmatched.length > 0">
				<li v-for="(miss, index) in unmatched" :key="index">
					{{ miss.title }}<template v-if="miss.year !== null"> ({{ miss.year }})</template> — not in library
				</li>
			</ul>
		</div>
		<label v-if="sequential">
			<span>Order</span>
			<select v-model="sortType" aria-label="AI selection order">
				<option value="date-added">Indexed date</option>
				<option value="name">Title</option>
				<option value="release-date">Release date</option>
			</select>
		</label>
		<label v-if="sequential">
			<span>Direction</span>
			<select v-model="sortDirection" aria-label="AI selection direction">
				<option value="asc">Ascending</option>
				<option value="desc">Descending</option>
			</select>
		</label>
	</div>
</template>
