<script setup lang="ts">
import { CircleAlert } from '@lucide/vue';
import { RouterLink } from 'vue-router';
import ResourceEmptyState from '../components/ResourceEmptyState.vue';
</script>

<template>
	<section>
		<ResourceEmptyState
			title="Page Not Found"
			description="404 Not Found"
		>
			<template #icon><CircleAlert :size="37" /></template>
			<RouterLink class="button" to="/">Go to Status</RouterLink>
		</ResourceEmptyState>
	</section>
</template>
