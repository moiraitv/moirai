<script setup lang="ts">
import { computed } from 'vue';
import { isFillerProgram, defaultMidRollConfig, defaultFillerAssignment, type FillerKind, type SlotFillerAssignment, type SchedulingProgram } from '@moirai/shared';
import FillerAssignmentEditor from '../schedules/FillerAssignmentEditor.vue';

const props = defineProps<{ modelValue: SlotFillerAssignment | undefined; programs: SchedulingProgram[]; kind?: FillerKind; heading?: string }>();
const emit = defineEmits<{
	'update:modelValue': [value: SlotFillerAssignment];
	'edit-program': [programId: string];
}>();
const fillerPrograms = computed(() => props.programs.filter(isFillerProgram));

/** Configure an override only when there is an available filler Program. */
function mode(value: string): void {
	if (value === 'configured') {
		if (fillerPrograms.value[0]) {
			emit('update:modelValue', { mode: 'configured', config: props.kind && props.kind !== 'mid-roll' ? defaultFillerAssignment(props.kind, fillerPrograms.value[0].id) : defaultMidRollConfig(fillerPrograms.value[0].id) });
		}
	}
	else {
		emit('update:modelValue', { mode: value === 'disabled' ? 'disabled' : 'inherit' });
	}
}
</script>

<template>
	<fieldset class="mid-roll-slot-mode">
		<legend>{{ heading ?? 'Slot mid-roll' }}</legend>
		<label><span>Mode</span>
			<select :value="modelValue?.mode ?? 'inherit'" @change="mode(($event.target as HTMLSelectElement).value)">
				<option value="inherit">Inherit template/channel</option>
				<option value="disabled">Disabled</option>
				<option value="configured" :disabled="fillerPrograms.length === 0">Slot override</option>
			</select>
		</label>
		<FillerAssignmentEditor
			v-if="modelValue?.mode === 'configured'" :model-value="modelValue.config" :programs="programs"
			:kind="kind ?? 'mid-roll'" :heading="`${heading ?? 'Slot mid-roll'} settings`" eyebrow="Slot behavior"
			@update:model-value="value => emit('update:modelValue', value ? { mode: 'configured', config: value } : { mode: 'inherit' })"
			@edit-program="emit('edit-program', $event)" />
	</fieldset>
</template>
