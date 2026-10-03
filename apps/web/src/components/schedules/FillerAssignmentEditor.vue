<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue';
import { Pencil } from '@lucide/vue';
import { isFillerProgram, defaultMidRollConfig, defaultFillerAssignment, type FillerKind, type FillerAssignment, type AnyFillerPreset, type SchedulingProgram } from '@moirai/shared';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import LoadingState from '../LoadingState.vue';
import { fillerPresetContext } from '../../filler-preset-context';

const props = withDefaults(defineProps<{
	modelValue: FillerAssignment | null | undefined; programs: SchedulingProgram[]; heading?: string; eyebrow?: string; kind?: FillerKind;
}>(), { heading: 'Mid-Roll', eyebrow: 'Filler behavior', kind: 'mid-roll' });
const emit = defineEmits<{ 'update:modelValue': [value: FillerAssignment | null]; 'edit-program': [programId: string] }>();
const fillerPrograms = computed(() => props.programs.filter(isFillerProgram));
const catalog = inject(fillerPresetContext, null);
const presets = ref<AnyFillerPreset[]>([]);
const loaded = ref(false);
const error = ref('');
const programId = computed(() => props.modelValue?.programId || fillerPrograms.value[0]?.id || '');
const presetId = computed(() => props.modelValue?.presetId ?? (props.kind === 'mid-roll' ? defaultMidRollConfig(programId.value) : defaultFillerAssignment(props.kind, programId.value)).presetId);

/** Load saved presets before presenting assignment choices. */
async function load(): Promise<void> {
	error.value = '';
	try {
		presets.value = catalog ? catalog.value.filter(preset => preset.kind === props.kind) : await api.fillerPresets(props.kind);
		loaded.value = true;
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

/** Update the enabled assignment’s break behavior. */
function selectMidRoll(presetId: string): void {
	if (props.modelValue && presetId && programId.value) {
		emit('update:modelValue', { presetId, programId: programId.value });
	}
}

/** Update the enabled assignment’s source Program. */
function selectProgram(value: string): void {
	if (props.modelValue) {
		emit('update:modelValue', { ...props.modelValue, programId: value });
	}
}

/** Enable the standard assignment or remove it when the checkbox is unchecked. */
function toggle(enabled: boolean): void {
	if (enabled && loaded.value && programId.value) {
		emit('update:modelValue', props.kind === 'mid-roll' ? defaultMidRollConfig(programId.value) : defaultFillerAssignment(props.kind, programId.value));
	}
	else if (!enabled) {
		emit('update:modelValue', null);
	}
}

onMounted(load);
</script>

<template>
	<section class="mid-roll-editor template-default-filler-panel editor-surface" role="group" :aria-label="heading">
		<div class="template-panel-heading"><div><p class="eyebrow">{{ eyebrow }}</p><h2>{{ heading }}</h2></div></div>
		<p class="template-default-filler-description">Choose a preset and Source Program. {{ kind === 'tail' ? 'Tail filler runs after primary programming, before channel fallback.' : 'Filler time counts toward fitting each item into its slot.' }}</p>
		<LoadingState v-if="!loaded && !error" label="Loading filler presets…" />
		<p v-if="error" class="notice error">{{ error }} <button type="button" @click="load">Retry</button></p>
		<div class="template-default-filler-row" :class="{ 'is-disabled': !modelValue }">
			<label class="template-default-filler-toggle">
				<input type="checkbox" :aria-label="`Use ${heading.toLowerCase()}`" :checked="!!modelValue" :disabled="!modelValue && (!loaded || !programId)" @change="toggle(($event.target as HTMLInputElement).checked)" />
			</label>
			<label class="template-default-filler-field"><span>Preset</span><select aria-label="Preset" :value="presetId" :disabled="!modelValue || !loaded" @change="selectMidRoll(($event.target as HTMLSelectElement).value)">
				<option value="" disabled>Select a preset</option>
				<option v-if="loaded && modelValue && !presets.some(preset => preset.id === modelValue?.presetId)" :value="modelValue.presetId">Selected preset unavailable</option>
				<option v-for="preset in presets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
			</select></label>
			<label class="template-default-filler-field"><span>Source Program</span><span class="template-program-control"><select aria-label="Source Program" :value="programId" :disabled="!modelValue || fillerPrograms.length === 0" @change="selectProgram(($event.target as HTMLSelectElement).value)"><option v-for="program in fillerPrograms" :key="program.id" :value="program.id">{{ program.name }}</option></select><button type="button" class="template-edit-program-button" aria-label="Edit filler Program" :disabled="!modelValue || !programId" @click="emit('edit-program', programId)"><Pencil :size="16" />Edit</button></span></label>
		</div>
	</section>
</template>
