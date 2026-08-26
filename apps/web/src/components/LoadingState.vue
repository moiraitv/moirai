<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: 'Loading…' });
</script>

<template>
	<div class="loading-state" role="status" aria-live="polite">
		<span class="loading-spinner" aria-hidden="true"></span>
		<span>{{ label }}</span>
	</div>
</template>
