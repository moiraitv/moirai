<script setup lang="ts">
import { computed } from 'vue';
import { Ellipsis } from '@lucide/vue';
import type { SchedulingProgramPreviewItem } from '@moirai/shared';
import ProgramThumbnails from './ProgramThumbnails.vue';
const props = defineProps<{ items: SchedulingProgramPreviewItem[]; indexedCount: number }>();
const total = computed(() => Math.max(props.indexedCount, props.items.length));
</script>
<template>
	<span class="program-source-preview" :title="`Sample of ${total} indexed items`">
		<ProgramThumbnails :items="items.slice(0, 3)" />
		<span class="program-source-more" :class="{ 'more-at-three': total > Math.min(3, items.length), 'more-at-two': total > Math.min(2, items.length), 'more-at-one': total > Math.min(1, items.length) }" aria-label="And more items">
			<Ellipsis :size="16" aria-hidden="true" /><span>more</span>
		</span>
	</span>
</template>
