<script setup lang="ts">
import type { Component } from 'vue';
defineProps<{ title: string; description?: string; icon: Component }>();
</script>
<template>
	<section class="source-editor-card" :aria-label="title">
		<header class="source-editor-card-heading"><span class="source-editor-card-icon" aria-hidden="true"><component :is="icon" :size="28" /></span><div><h3>{{ title }}</h3><p v-if="description">{{ description }}</p></div></header>
		<div class="form-grid"><slot /></div>
	</section>
</template>
