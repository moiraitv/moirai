<script setup lang="ts">
import ProgramFilterSummary from './ProgramFilterSummary.vue';
import { computed } from 'vue';
import type { SchedulingProgram, SchedulingProgramStatus } from '@moirai/shared';
import { programValueLabel } from './program-catalog';
const props = defineProps<{ program: SchedulingProgram; status?: SchedulingProgramStatus | undefined; libraries: { id: string; name: string }[] }>();
const config = computed(() => props.program.config.type === 'content' ? props.program.config : null);
const libraryName = computed(() => {
	const source = config.value?.source;
	const id = source && 'libraryId' in source ? source.libraryId : props.status?.previewItems[0]?.libraryId;
	return props.libraries.find(library => library.id === id)?.name ?? 'Unavailable library';
});
</script>
<template>
	<section v-if="config" class="program-inspector-section">
		<h3>Definition</h3>
		<p>{{ status?.sourceLabel }}</p>
		<dl><dt>Source Library</dt><dd>{{ libraryName }}</dd><dt>Selection</dt><dd>{{ programValueLabel(config.strategy.type) }}</dd>
			<template v-if="config.source.type === 'collection'"><dt>Selected items</dt><dd>{{ config.source.itemIds.length }}</dd><dt>Order</dt><dd>{{ config.source.sort.type }}</dd></template>
			<template v-if="config.source.type === 'group-collection'"><dt>Selected groups</dt><dd>{{ config.source.groupIds.length }}</dd></template>
			<template v-if="config.source.type === 'library-query'">
				<template v-if="config.source.itemLimit"><dt>Item limit</dt><dd>{{ config.source.itemLimit }}</dd></template>
			</template>
		</dl>
		<ProgramFilterSummary v-if="config.source.type === 'library-query'" :filter="config.source" />
	</section>
</template>
