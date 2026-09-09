<script setup lang="ts">
import PageHelpButton from './PageHelpButton.vue';
defineProps<{ eyebrow?: string; title: string; description?: string }>();
</script>
<template>
	<header class="page-header">
		<div>
			<p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
			<div class="page-title-with-help"><h1>{{ title }}</h1><PageHelpButton :label="title" /></div>
			<p v-if="description" class="lede">{{ description }}</p>
		</div>
		<div class="header-actions"><slot /></div>
	</header>
</template>
