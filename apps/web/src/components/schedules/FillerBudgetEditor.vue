<script setup lang="ts">
import { canonicalFillerPolicy } from '@moirai/shared';
import { FILLER_PAD_MINUTES, type FillerBudget } from '@moirai/shared';
const props = defineProps<{ modelValue: FillerBudget; allowRemaining?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: FillerBudget] }>();

/** Replace the active budget with valid defaults for the selected mode. */
function mode(type: string): void {
	const budget: FillerBudget = type === 'count' ? { type, count: 1 }
		: type === 'random-count' ? { type, minimum: 1, maximum: 4 }
			: type === 'pad' ? { type, minutes: 15, policy: 'next-truncate' }
				: type === 'remaining' ? { type, policy: 'next-truncate' }
					: { type: 'duration', seconds: 120, policy: 'next-truncate' };
	emit('update:modelValue', budget);
}
/** Update one value while preserving the selected budget mode. */
function update(field: string, value: number | string): void {
	emit('update:modelValue', { ...props.modelValue, [field]: value } as FillerBudget);
}
</script>
<template>
	<div class="form-grid">
		<label><span>Budget per Break</span><select :value="modelValue.type" @change="mode(($event.target as HTMLSelectElement).value)"><option value="duration">Fixed duration</option><option value="pad">Pad to clock</option><option value="count">Fixed quantity</option><option value="random-count">Random quantity</option><option v-if="allowRemaining" value="remaining">Fill remaining slot</option></select></label>
		<label v-if="modelValue.type === 'duration'"><span>Seconds per Break</span><input type="number" min="1" max="86400" :value="modelValue.seconds" @input="update('seconds', Number(($event.target as HTMLInputElement).value))" /></label>
		<label v-if="modelValue.type === 'count'"><span>Items per Break</span><input type="number" min="1" max="100" :value="modelValue.count" @input="update('count', Number(($event.target as HTMLInputElement).value))" /></label>
		<template v-if="modelValue.type === 'random-count'"><label><span>Minimum Items</span><input type="number" min="0" max="100" :value="modelValue.minimum" @input="update('minimum', Number(($event.target as HTMLInputElement).value))" /></label><label><span>Maximum Items</span><input type="number" min="0" max="100" :value="modelValue.maximum" @input="update('maximum', Number(($event.target as HTMLInputElement).value))" /></label></template>
		<label v-if="modelValue.type === 'pad'"><span>Clock Interval (minutes)</span><select :value="modelValue.minutes" @change="update('minutes', Number(($event.target as HTMLSelectElement).value))"><option v-for="minutes in FILLER_PAD_MINUTES" :key="minutes" :value="minutes">{{ minutes }} minutes</option></select><small>Pad to the next boundary in the channel’s time zone. An exact boundary needs no filler.</small></label>
		<label v-if="'policy' in modelValue"><span>Fitting Behavior</span><select :value="canonicalFillerPolicy(modelValue.policy)" @change="update('policy', ($event.target as HTMLSelectElement).value)"><option value="next-truncate">Allow Truncation</option><option value="next-fit-only">Whole Items Only</option></select></label>
	</div>
</template>
