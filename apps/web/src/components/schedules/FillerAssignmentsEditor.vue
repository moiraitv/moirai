<script setup lang="ts">
import { computed, onMounted, provide, ref, useId } from 'vue';
import type { FillerKind, AnyFillerPreset } from '@moirai/shared';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import { fillerPresetContext } from '../../filler-preset-context';
import { FILLER_STAGES, effectiveFillerAssignments, simulateFiller, type FillerAssignments, type FillerOverrides } from '../../filler-simulation';
import { fillerBudgetSummary } from '../../filler-budget';
import LoadingState from '../LoadingState.vue';

const props = defineProps<{ assignments: FillerAssignments; overrides?: FillerOverrides; heading: string }>();
const selected = ref<FillerKind>('mid-roll');
const radioName = useId();
const presets = ref<AnyFillerPreset[]>([]);
const loaded = ref(false);
const error = ref('');
const assignments = computed(() => effectiveFillerAssignments(props.assignments, props.overrides));
const spans = computed(() => simulateFiller(assignments.value, presets.value));
const selectedPreset = computed(() => presets.value.find(preset => preset.kind === selected.value && preset.id === assignments.value[selected.value]?.presetId));
const midCount = computed(() => spans.value.filter(span => span.kind === 'mid-roll').length);
provide(fillerPresetContext, presets);

/** Fetch all stage choices once for the illustration and selected controls. */
async function load(): Promise<void> {
	error.value = '';
	try {
		presets.value = await api.fillerPresets();
		loaded.value = true;
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

/** Describe inherited decisions without confusing them with an explicit slot override. */
function status(kind: FillerKind): string {
	const active = !!assignments.value[kind];
	return props.overrides && (!props.overrides[kind] || props.overrides[kind]?.mode === 'inherit')
		? `Inherited · ${active ? 'active' : 'inactive'}` : active ? 'Active' : 'Inactive';
}

/** Show the source-content location and illustrative filler duration of a selectable gap. */
function gapLabel(kind: FillerKind, point: number, seconds: number): string {
	const label = FILLER_STAGES.find(stage => stage.kind === kind)!.label;
	return `${label} · ${status(kind)} · ${Math.round(seconds)} seconds${kind === 'mid-roll' ? ` at ${Math.floor(point / 60)}:${String(Math.floor(point % 60)).padStart(2, '0')} of content` : ''}`;
}

onMounted(load);
</script>

<template>
	<section class="filler-assignments editor-surface" role="group" :aria-label="heading">
		<div class="template-panel-heading"><div><p class="eyebrow">Filler assignments</p><h2>{{ heading }}</h2></div></div>
		<p class="filler-example-caption">Example movie · 137 minutes of content · starts at 20:03</p>
		<LoadingState v-if="!loaded && !error" label="Loading filler presets…" />
		<p v-if="error" class="notice error">{{ error }} <button type="button" @click="load">Retry</button></p>
		<template v-if="loaded">
			<div class="filler-example" aria-label="Illustrative movie timeline">
				<div class="filler-example-track">
					<template v-for="(span, index) in spans" :key="index">
						<div v-if="span.kind === 'content'" class="filler-example-content" :style="{ flexGrow: span.seconds }" :title="`${Math.round(span.seconds / 60)} minutes of movie`"><span>Movie</span></div>
						<button v-else type="button" class="filler-example-gap" :class="{ 'is-active': span.active, 'is-selected': selected === span.kind }" :style="{ flexGrow: span.seconds }" :aria-label="gapLabel(span.kind, span.point, span.seconds)" :aria-pressed="selected === span.kind" :title="gapLabel(span.kind, span.point, span.seconds)" @click="selected = span.kind"><span>{{ span.kind === 'tail' ? 'T' : span.kind === 'pre-roll' ? 'P' : span.kind === 'post-roll' ? 'P' : 'M' }}</span></button>
					</template>
				</div>
				<div class="filler-example-endpoints"><span>Before content</span><span>After content → slot end</span></div>
			</div>
			<div class="filler-stage-selector" role="radiogroup" aria-label="Filler type">
				<label v-for="stage in FILLER_STAGES" :key="stage.kind" :class="{ 'is-selected': selected === stage.kind, 'is-active': !!assignments[stage.kind] }">
					<input v-model="selected" type="radio" :name="radioName" :value="stage.kind" />
					<span>{{ stage.label }}<small>{{ status(stage.kind) }}</small></span>
				</label>
			</div>
			<p class="filler-example-detail" aria-live="polite">
				{{ selectedPreset ? `${selectedPreset.name} · ${fillerBudgetSummary(selectedPreset.budget)}.` : assignments[selected] ? 'Selected preset unavailable.' : 'Inactive gaps show where filler would play when enabled.' }}
				<template v-if="selected === 'mid-roll' && selectedPreset"> {{ midCount }} matching timed {{ midCount === 1 ? 'break' : 'breaks' }} in this movie. Real chapter boundaries replace timed points when available.</template>
			</p>
			<div class="filler-selected-assignment"><slot :name="selected" /></div>
		</template>
	</section>
</template>
