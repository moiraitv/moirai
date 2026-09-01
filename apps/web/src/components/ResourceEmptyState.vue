<script setup lang="ts">
/** Content and semantic heading configuration for an actionable resource empty state. */
interface ResourceEmptyStateProps {
	title: string;
	description: string;
	headingLevel?: 2 | 3;
	compact?: boolean;
}

withDefaults(defineProps<ResourceEmptyStateProps>(), {
	headingLevel: 2,
	compact: false,
});
</script>

<template>
	<div class="resource-empty-state" :class="{ compact }">
		<div class="resource-empty-icon" aria-hidden="true">
			<slot name="icon"></slot>
		</div>
		<component :is="`h${headingLevel}`" class="resource-empty-title">{{ title }}</component>
		<p class="resource-empty-description">{{ description }}</p>
		<div class="resource-empty-actions">
			<slot></slot>
		</div>
		<div v-if="$slots.secondary" class="resource-empty-secondary">
			<slot name="secondary"></slot>
		</div>
	</div>
</template>
