<script setup lang="ts">
import { legacyTailPresetId, type FillerConfig, type FillerAssignment, type SchedulingProgram } from '@moirai/shared';
import FillerAssignmentEditor from './FillerAssignmentEditor.vue';
const props = defineProps<{ modelValue: FillerConfig | null | undefined; programs: SchedulingProgram[]; heading: string; eyebrow?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: FillerConfig | null]; 'edit-program': [programId: string] }>();
/** Retain the legacy policy for older clients while assigning reusable tail behavior. */
function update(value: FillerAssignment | null): void {
	emit('update:modelValue', value ? { ...value, policy: props.modelValue?.policy ?? 'best-fit-or-truncate' } : null);
}
</script>
<template>
	<FillerAssignmentEditor kind="tail" :model-value="modelValue ? { programId: modelValue.programId, presetId: modelValue.presetId ?? legacyTailPresetId(modelValue.policy) } : null" :programs="programs" :heading="heading" :eyebrow="eyebrow ?? 'Filler behavior'" @update:model-value="update" @edit-program="emit('edit-program', $event)" />
</template>
