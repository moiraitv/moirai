<script setup lang="ts">
import { Search } from '@lucide/vue';
import { programTypes, contentSubtypeLabels, type ProgramCatalogFilters } from './program-catalog';
defineProps<{ filters: ProgramCatalogFilters }>();
const emit = defineEmits<{ change: [update: Record<string, string | null>, replace?: boolean] }>();
</script>
<template>
	<div class="program-management-toolbar">
		<label class="program-search-control"><Search :size="18" /><input type="search" aria-label="Search programs" placeholder="Search programs…" :value="filters.q" @input="emit('change', { q: ($event.target as HTMLInputElement).value }, true)" /></label>
		<select aria-label="Filter programs by type" :value="filters.type || 'all'" @change="emit('change', { type: ($event.target as HTMLSelectElement).value, subtype: null })"><option value="all">All types</option><option v-for="(label, type) in programTypes" :key="type" :value="type">{{ label }}</option></select>
		<select v-if="!filters.type || ['all', 'content'].includes(filters.type)" aria-label="Filter Content definition" :value="filters.subtype || 'all'" @change="emit('change', { subtype: ($event.target as HTMLSelectElement).value })"><option value="all">All definitions</option><option v-for="(label, key) in contentSubtypeLabels" :key="key" :value="key">{{ label }}</option></select>
		<select aria-label="Filter program usage" :value="filters.usage || 'all'" @change="emit('change', { usage: ($event.target as HTMLSelectElement).value })"><option value="all">All usage</option><option value="used">Used</option><option value="unused">Unused</option></select>
		<select aria-label="Sort programs" :value="filters.sort || 'name'" @change="emit('change', { sort: ($event.target as HTMLSelectElement).value })"><option value="name">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="updated">Recently updated</option><option value="usage">Most references</option></select>
	</div>
</template>
