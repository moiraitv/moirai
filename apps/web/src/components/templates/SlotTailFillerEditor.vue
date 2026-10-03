<script setup lang="ts">
import { legacyTailPresetId, type ScheduleSlot, type SlotFillerAssignment, type SchedulingProgram } from '@moirai/shared';
import SlotFillerEditor from './SlotFillerEditor.vue';
const props = defineProps<{ modelValue: ScheduleSlot['filler']; programs: SchedulingProgram[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: ScheduleSlot['filler']]; 'edit-program': [programId: string] }>();
/** Preserve the legacy fitting policy alongside the selected tail preset. */
function update(value: SlotFillerAssignment): void {
	emit('update:modelValue', value.mode === 'configured' ? { mode: 'configured', config: { ...value.config,
		policy: props.modelValue.mode === 'configured' ? props.modelValue.config.policy : 'best-fit-or-truncate' } } : value);
}
</script>
<template>
	<SlotFillerEditor kind="tail" heading="Tail filler" :model-value="modelValue.mode === 'configured' ? { mode: 'configured', config: { programId: modelValue.config.programId, presetId: modelValue.config.presetId ?? legacyTailPresetId(modelValue.config.policy) } } : modelValue" :programs="programs" @update:model-value="update" @edit-program="emit('edit-program', $event)" />
</template>
