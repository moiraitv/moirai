<script setup lang="ts">
import { computed } from 'vue';
import { FileText } from '@lucide/vue';
import type { SchedulingProgram, SchedulingProgramStatus } from '@moirai/shared';
import SequenceSourcePreview from './SequenceSourcePreview.vue';
const props = defineProps<{ program: SchedulingProgram; programs: Map<string, SchedulingProgram>; statuses: Map<string, SchedulingProgramStatus> }>();
const emit = defineEmits<{ select: [id: string] }>();
const entries = computed(() => props.program.config.type === 'sequence' ? props.program.config.entries : []);
const cycleCount = computed(() => entries.value.reduce((sum, entry) => sum + entry.count, 0));
/** Describe the configured selections for one step without simulating playback. */
function itemCountLabel(count: number): string {
	return `${count} ${count === 1 ? 'Item' : 'Items'}`;
}
</script>
<template>
	<section v-if="program.config.type === 'sequence'" class="program-inspector-section program-sequence-configuration">
		<h3 class="eyebrow">Sequence Configuration</h3>
		<p class="program-sequence-total">{{ cycleCount }} {{ cycleCount === 1 ? 'item' : 'items' }} per cycle</p>
		<ol class="program-source-list">
			<li v-for="(entry, index) in entries" :key="entry.id">
				<button type="button" class="program-source-block" :disabled="!programs.has(entry.programId)" :aria-label="`${index + 1}. ${programs.get(entry.programId)?.name ?? 'Missing Program'}, ${itemCountLabel(entry.count)}`" @click="emit('select', entry.programId)">
					<span class="program-source-index" aria-hidden="true">{{ index + 1 }}</span>
					<SequenceSourcePreview v-if="programs.has(entry.programId) && statuses.get(entry.programId)?.previewItems.length" :items="statuses.get(entry.programId)!.previewItems" :indexed-count="statuses.get(entry.programId)!.indexedItemCount" />
					<span v-else class="program-source-placeholder" aria-hidden="true"><FileText :size="16" /></span>
					<span class="program-source-copy"><strong :title="programs.get(entry.programId)?.name ?? 'Missing Program'">{{ programs.get(entry.programId)?.name ?? 'Missing Program' }}</strong><small>{{ itemCountLabel(entry.count) }}</small></span>
				</button>
			</li>
		</ol>
		<p>{{ program.config.repeat ? 'Repeats the sequence in configured order.' : 'Plays the sequence once in configured order.' }}</p>
	</section>
</template>
