<script setup lang="ts">
import { CirclePlus, ExternalLink, Layers3 } from '@lucide/vue';

defineProps<{ expanded: boolean }>();
const emit = defineEmits<{ show: [] }>();

/** TODO: Enable once the layered-scheduling introduction has finalized guide content. */
const introductoryCalloutVisible = false;

/** Steps that introduce the layered scheduling workflow. */
const guideItems = [
	{ title: 'Choose a base', detail: 'The base template supplies normal programming.' },
	{ title: 'Stack conditions', detail: 'Higher templates apply only when their predicates match.' },
	{ title: 'Preview the result', detail: 'Moirai resolves the stack into concrete playback times.' },
];
</script>

<template>
	<section v-if="introductoryCalloutVisible" class="layered-scheduling-callout">
		<div class="layered-scheduling-illustration"><Layers3 :size="43" /><CirclePlus :size="20" /></div>
		<div><h2>New to layered scheduling?</h2><p>Learn how templates, conditions, and overrides work together to build powerful, flexible programming.</p></div>
		<button type="button" class="button secondary" @click="emit('show')">View Guide <ExternalLink :size="17" /></button>
	</section>
	<Transition name="moirai-collapse">
		<section v-if="expanded" id="layered-scheduling-guide" class="layered-scheduling-guide editor-surface">
			<article v-for="(item, index) in guideItems" :key="item.title">
				<span>{{ index + 1 }}</span>
				<div><strong>{{ item.title }}</strong><p>{{ item.detail }}</p></div>
			</article>
		</section>
	</Transition>
</template>
