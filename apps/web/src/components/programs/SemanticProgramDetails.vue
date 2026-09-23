<script setup lang="ts">
import ProgramFilterSummary from './ProgramFilterSummary.vue';
import { computed, ref, watch } from 'vue';
import type { SchedulingProgram, SchedulingProgramStatus } from '@moirai/shared';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import TransientToast from '../TransientToast.vue';
const props = defineProps<{ program: SchedulingProgram; programs: Map<string, SchedulingProgram>; status?: SchedulingProgramStatus | undefined; libraries: { id: string; name: string }[] }>();
const emit = defineEmits<{ select: [id: string]; refresh: [] }>();
const config = computed(() => {
	const value = props.program.config;
	return value.type === 'similarity' || value.type === 'theme' ? value : null;
});
const libraryName = computed(() => {
	const value = config.value;
	return value?.type === 'theme' ? props.libraries.find(library => library.id === value.libraryId)?.name ?? 'Unavailable library' : '';
});
const retrying = ref(false);
const error = ref('');
const notice = ref('');
watch(() => props.program.id, () => {
	error.value = '';
	notice.value = '';
});
/** Retry failed preparation using the saved definition without replacing committed sets. */
async function retry(): Promise<void> {
	if (!config.value || retrying.value) {
		return;
	}
	const id = props.program.id;
	retrying.value = true;
	error.value = '';
	try {
		const result = await api.retrySimilarityEmbeddings(config.value);
		if (props.program.id === id) {
			notice.value = `${result.queued} preparation tasks queued for retry.`;
		}
		emit('refresh');
	}
	catch (cause) {
		if (props.program.id === id) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		retrying.value = false;
	}
}
</script>
<template>
	<section v-if="config" class="program-inspector-section">
		<h3>Definition</h3>
		<template v-if="config.type === 'similarity'"><h4>Source Program</h4><button v-if="programs.has(config.sourceProgramId)" type="button" class="button secondary" @click="emit('select', config.sourceProgramId)">{{ programs.get(config.sourceProgramId)?.name }}</button><p v-else>Missing source Program</p></template>
		<template v-else><h4>Prompt</h4><p class="program-prompt">{{ config.theme }}</p><p>Source Library: {{ libraryName }}</p></template>
		<h4>Generation settings</h4>
		<dl><dt>Quantity</dt><dd>{{ config.quantity }}</dd><dt>Cohesion / Variety</dt><dd>{{ config.variety }} / 100</dd>
			<template v-if="config.softPreferences"><dt>Preferences</dt><dd>{{ config.softPreferences }}</dd></template>
			<template v-if="config.hardExclusions?.length"><dt>Exclusions</dt><dd>{{ config.hardExclusions.join(', ') }}</dd><dt>Exclusion strictness</dt><dd>{{ config.exclusionStrictness ?? 'Default' }}</dd></template>
		</dl>
		<ProgramFilterSummary v-if="config.filter" :filter="config.filter" />
		<h4>Current sets</h4>
		<p v-for="set in status?.currentSets ?? []" :key="set.consumerKey">{{ set.channelName ?? 'Schedule use' }} · set {{ set.generation }}: {{ set.remaining }} of {{ set.total }} remaining.</p>
		<p v-if="status && !status.currentSets?.length">No committed sets reported.</p>
		<p class="muted">Each schedule use generates its next set automatically. Saved settings apply to future sets.</p>
		<button v-if="status?.failedEmbeddingCount" type="button" class="button secondary" :disabled="retrying" @click="retry">{{ retrying ? 'Queueing retry…' : 'Retry preparation' }}</button>
		<p v-if="error" class="notice error" role="alert">{{ error }}</p>
		<TransientToast v-if="notice" :message="notice" @close="notice = ''" />
	</section>
</template>
