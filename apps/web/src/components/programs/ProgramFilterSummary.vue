<script setup lang="ts">
import { computed } from 'vue';
import { catalogProgramItemFilterSchema } from '@moirai/shared';
import { catalogProgramItemFilterSummary } from '../library/library-filter';
const props = defineProps<{ filter: unknown }>();
const labels = computed(() => {
	const parsed = catalogProgramItemFilterSchema.safeParse(props.filter);
	return parsed.success ? catalogProgramItemFilterSummary(parsed.data) : [];
});
</script>
<template>
	<div v-if="labels.length"><h4>Library filters</h4><ul class="program-filter-summary"><li v-for="label in labels" :key="label">{{ label }}</li></ul></div>
</template>
