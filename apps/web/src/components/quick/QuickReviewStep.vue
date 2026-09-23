<script setup lang="ts">
import { useDisclosureState } from '../../disclosure-state';
import QuickStepActions from './QuickStepActions.vue';
import type { Library, QuickChannelSetupCreate } from '@moirai/shared';
import { RefreshCw } from '@lucide/vue';
import type { PreparedChannelLogo } from '../../channel-logo-image';
import { quickSourceSummary } from '../../quick-setup';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { QuickChannelSetupPreviewResult } from '@moirai/shared/api-contracts';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import QuickQueryPreview from './QuickQueryPreview.vue';
import QuickScheduleSample from './QuickScheduleSample.vue';
import LoadingState from '../LoadingState.vue';

const warningsOpen = useDisclosureState('quick-review-warnings');

const props = defineProps<{
	request: QuickChannelSetupCreate;
	library: Library;
	logo: PreparedChannelLogo | null;
	busy: boolean;
	error: string;
	templateName: string;
}>();
const emit = defineEmits<{ back: []; finish: [] }>();
const preview = ref<QuickChannelSetupPreviewResult | null>(null);
const loading = ref(false);
const previewError = ref('');
let sequence = 0;
let controller: AbortController | undefined;

/** Refresh the illustrative review without clearing the last successfully resolved sample. */
async function refresh(): Promise<void> {
	const current = ++sequence;
	controller?.abort();
	controller = new AbortController();
	loading.value = true;
	previewError.value = '';
	try {
		const result = await api.previewQuickChannelSetup(props.request, controller.signal);
		if (sequence === current) {
			preview.value = result;
		}
	}
	catch (cause) {
		if (sequence === current) {
			previewError.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === current) {
			loading.value = false;
		}
	}
}
onMounted(() => void refresh());
onBeforeUnmount(() => {
	sequence += 1;
	controller?.abort();
});
</script>

<template>
	<section class="quick-step" aria-labelledby="quick-review-title">
		<div class="quick-step-heading quick-review-heading">
			<button class="button secondary quick-review-refresh" type="button" :disabled="loading || busy" :aria-label="loading ? 'Refreshing preview' : previewError ? 'Retry Preview' : 'Refresh Preview'" :title="previewError ? 'Retry Preview' : 'Refresh Preview'" @click="refresh"><RefreshCw :size="18" aria-hidden="true" /></button>
			<p class="eyebrow">Step 4 of 4</p>
			<h2 id="quick-review-title">Review the setup</h2>
			<p>Finish creates the four linked resources together, then uploads the optional logo.</p>
		</div>
		<div class="quick-review-grid">
			<article class="panel quick-review-row">
				<h3>Library</h3><div class="quick-review-content">
					<strong>{{ library.name }}</strong><small>{{ library.typeKey }} · {{ library.itemCount.toLocaleString() }} indexed</small>
					<small class="quick-review-scan-status"><template v-if="library.lastScanStartedAt && (!library.lastScanCompletedAt || library.lastScanStartedAt > library.lastScanCompletedAt)">Scanning — samples reflect indexed media so far.</template></small>
					<QuickQueryPreview
						heading="Library sample · up to 12 items" label="Library sample"
						:items="preview?.library.items ?? []" :indexed-item-count="preview?.library.indexedItemCount ?? 0"
						:loading="loading" :loaded="preview !== null" :loading-more="false" :has-more="false" :error="previewError" @retry="refresh" />
				</div>
			</article>
			<article class="panel quick-review-row">
				<h3>Programming</h3><div class="quick-review-content">
					<strong>{{ request.programName }}</strong>
					<small>{{ request.source.type === 'library-query' ? 'Library query' : request.source.type === 'collection' ? 'Specific items' : 'Shows or seasons' }} · {{ request.strategy.type }}</small>
					<small>{{ quickSourceSummary(request.source) }}</small>
					<QuickQueryPreview
						heading="Source sample · up to 12 items" label="Programming sample"
						:items="preview?.programming.items ?? []" :indexed-item-count="preview?.programming.indexedItemCount ?? 0"
						:loading="loading" :loaded="preview !== null" :loading-more="false" :has-more="false" :error="previewError" @retry="refresh" />
				</div>
			</article>
			<article class="panel quick-review-row">
				<h3>Channel</h3><div class="quick-review-channel">
					<img v-if="logo" :src="logo.previewUrl" alt="Channel logo" />
					<span v-else class="quick-review-logo-placeholder">No logo</span>
					<div class="quick-review-content"><strong>{{ request.channel.number }} · {{ request.channel.name }}</strong><small>{{ request.channel.group || 'No group' }}</small></div>
				</div>
			</article>
			<article class="panel quick-review-row">
				<h3>Daily schedule</h3><div class="quick-review-content">
					<strong>{{ preview?.templateName ?? templateName }}</strong><small>Continuous all day · media may finish across midnight</small>
				</div>
				<div class="quick-review-schedule-slot">
					<QuickScheduleSample v-if="preview" :preview="preview.schedule" />
					<LoadingState v-else-if="loading" label="Resolving…" />
					<p v-else>Schedule sample unavailable.</p>
				</div>
				<details v-if="preview?.schedule.issues.length" :open="warningsOpen" class="notice warning quick-review-schedule-warnings" @toggle="warningsOpen = ($event.target as HTMLDetailsElement).open">
					<summary>{{ preview.schedule.issues.length }} scheduling warning(s)</summary>
					<p v-for="(issue, index) in preview.schedule.issues" :key="index">{{ issue.message }}</p>
				</details>
			</article>
		</div>
		<p v-if="previewError" class="notice error">{{ previewError }} Preview failure does not prevent creation.</p>
		<QuickStepActions>
			<p v-if="error" class="notice error" role="alert">{{ error }}</p>
			<button class="button secondary" type="button" :disabled="busy" @click="emit('back')">Back</button>
			<button class="button" type="button" :disabled="busy" @click="emit('finish')">{{ busy ? 'Creating channel…' : 'Create Channel' }}</button>
		</QuickStepActions>
	</section>
</template>
