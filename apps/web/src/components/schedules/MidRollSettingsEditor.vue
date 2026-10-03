<script setup lang="ts">
import type { MidRollSettings } from '@moirai/shared';
import FillerBudgetEditor from './FillerBudgetEditor.vue';
import MidRollPredicateEditor from './MidRollPredicateEditor.vue';

const props = defineProps<{ modelValue: MidRollSettings; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: MidRollSettings] }>();

/** Replace edited behavior while retaining the other preset fields. */
function update(value: Partial<MidRollSettings>): void {
	emit('update:modelValue', { ...props.modelValue, ...value });
}

</script>

<template>
	<fieldset class="mid-roll-settings" :disabled="disabled">
		<legend>Break Settings</legend>
		<FillerBudgetEditor :model-value="modelValue.budget" @update:model-value="update({ budget: $event })" />
		<div class="form-grid mid-roll-fallback">
			<label><span>Timed Fallback Interval (seconds)</span><input type="number" min="1" max="86400" :value="modelValue.fallbackIntervalSeconds" @input="update({ fallbackIntervalSeconds: Number(($event.target as HTMLInputElement).value) })" /><small>Used only when the item has no usable interior chapter boundaries.</small></label>
		</div>
		<fieldset class="mid-roll-predicate"><legend>Break Conditions</legend><p>Times describe source content and exclude filler. Spacing is measured from the previous point accepted by this rule.</p><MidRollPredicateEditor :model-value="modelValue.predicate" @update:model-value="update({ predicate: $event })" /></fieldset>
		<p>If the Program cannot supply a break, content resumes immediately and schedule diagnostics report the shortfall.</p>
	</fieldset>
</template>
