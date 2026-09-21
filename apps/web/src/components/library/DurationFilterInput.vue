<script setup lang="ts">
import type { DurationFilterDraft } from './duration-filter';

defineProps<{ label: string; invalid: boolean; errorId: string }>();
const draft = defineModel<DurationFilterDraft>({ required: true });
</script>

<template>
	<fieldset class="filter-range-field filter-duration-bound">
		<legend>{{ label }}</legend>
		<div class="filter-duration-inputs">
			<label v-for="unit in (['hours', 'minutes', 'seconds'] as const)" :key="unit" class="filter-duration-unit">
				<span class="sr-only">{{ unit === 'hours' ? 'Hours' : unit === 'minutes' ? 'Minutes' : 'Seconds' }}</span>
				<input v-model="draft[unit]" type="text" inputmode="numeric" :aria-invalid="invalid || undefined" :aria-describedby="invalid ? errorId : undefined" placeholder="—" /><span class="filter-duration-suffix" aria-hidden="true">{{ unit[0] }}</span>
			</label>
		</div>
	</fieldset>
</template>
