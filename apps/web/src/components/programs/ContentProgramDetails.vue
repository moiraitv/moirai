<script setup lang="ts">
import { playbackOrderLabel } from './playback-order-label';
import ProgramFilterSummary from './ProgramFilterSummary.vue';
import { computed } from 'vue';
import type { SchedulingProgram, SchedulingProgramStatus } from '@moirai/shared';
import { programValueLabel } from './program-catalog';
const props = defineProps<{ program: SchedulingProgram; status?: SchedulingProgramStatus | undefined; libraries: { id: string; name: string }[] }>();
const config = computed(() => props.program.config.type === 'content' ? props.program.config : null);
const orderLabel = computed(() => {
	const source = config.value?.source;
	if (source?.type === 'collection' || source?.type === 'ai') {
		return playbackOrderLabel(source.sort, source.type === 'ai');
	}
	if (source?.type === 'library-query') {
		const field = source.sort?.type === 'name' || !source.sort ? 'Title / episode' : source.sort.type === 'date-added' ? 'Indexed date' : 'Release date';
		return `${field} · ${source.sort?.direction === 'desc' ? 'Descending' : 'Ascending'}`;
	}

	return source?.type === 'item' ? 'Exact item' : 'Season / episode · First to last';
});
const libraryName = computed(() => {
	const source = config.value?.source;
	const id = source && 'libraryId' in source ? source.libraryId : props.status?.previewItems[0]?.libraryId;
	return props.libraries.find(library => library.id === id)?.name ?? 'Unavailable library';
});
</script>
<template>
	<section v-if="config" class="program-inspector-section">
		<h3 class="eyebrow">Definition</h3>
		<p>{{ status?.sourceLabel }}</p>
		<dl><dt>Source Library</dt><dd>{{ libraryName }}</dd><dt>Selection</dt><dd>{{ programValueLabel(config.strategy.type) }}</dd>
			<template v-if="config.source.type === 'collection' || config.source.type === 'ai'"><dt>Selected items</dt><dd>{{ config.source.itemIds.length }}</dd></template>
			<template v-if="config.source.type === 'ai'"><dt>Prompt</dt><dd>{{ config.source.prompt }}</dd></template>
			<template v-if="config.source.type === 'group-collection'"><dt>Selected groups</dt><dd>{{ config.source.groupIds.length }}</dd></template>
			<template v-if="config.source.type === 'library-query'">
				<template v-if="config.source.itemLimit"><dt>Item limit</dt><dd>{{ config.source.itemLimit }}</dd></template>
			</template>
			<template v-if="config.strategy.type === 'sequential' || config.source.type === 'collection' || config.source.type === 'ai'"><dt>Playback order</dt><dd>{{ orderLabel }}</dd></template>
		</dl>
		<ProgramFilterSummary v-if="config.source.type === 'library-query'" :filter="config.source" />
	</section>
</template>
