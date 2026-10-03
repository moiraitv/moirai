<script setup lang="ts">
import { DEFAULT_FILLER_SHORTFALL_WARNING_THRESHOLD_PERCENT, playbackSettingsSchema } from '@moirai/shared';
import { numericInputAttributes, useFieldValidation } from '../field-validation';
import LoadingState from './LoadingState.vue';

const threshold = defineModel<number>({ required: true });
defineProps<{
	baseline: number | null;
	loading: boolean;
	loadError: string;
	busy: boolean;
}>();
const emit = defineEmits<{ retry: [] }>();
/** Percentage contract shared with persistence and generation. */
const schema = playbackSettingsSchema.pick({ fillerShortfallWarningThresholdPercent: true });
const validation = useFieldValidation(() => schema.safeParse({ fillerShortfallWarningThresholdPercent: threshold.value }));
const attributes = numericInputAttributes(schema.shape.fillerShortfallWarningThresholdPercent.removeDefault());
</script>

<template>
	<div class="form-grid filler-warning-settings">
		<h3 class="span-2">Break Budget Warnings</h3>
		<LoadingState v-if="loading" class="span-2" label="Loading filler settings…" />
		<div v-else-if="loadError" class="span-2">
			<p class="notice error" role="alert">{{ loadError }}</p>
			<button type="button" class="button secondary" @click="emit('retry')">Retry Settings</button>
		</div>
		<label v-if="baseline !== null" class="span-2">
			<span>Warn when filler supplies less than · {{ threshold }}%</span>
			<input v-model.number="threshold" type="range" aria-label="Warn when filler supplies less than (%)" :aria-valuetext="`${threshold}%`" :disabled="busy" v-bind="{ ...attributes, ...validation.attributes('fillerShortfallWarningThresholdPercent') }" />
			<small v-if="validation.error('fillerShortfallWarningThresholdPercent')" :id="validation.errorId('fillerShortfallWarningThresholdPercent')" class="field-error">{{ validation.error('fillerShortfallWarningThresholdPercent') }}</small>
			<small>Default: {{ DEFAULT_FILLER_SHORTFALL_WARNING_THRESHOLD_PERCENT }}%. Use 0 to turn off budget-shortfall warnings or 100 to warn about any incomplete budget. Applies to pre-roll, mid-roll, and post-roll in new previews and newly generated schedules. Existing warnings remain until their coverage is replaced.</small>
		</label>
	</div>
</template>
