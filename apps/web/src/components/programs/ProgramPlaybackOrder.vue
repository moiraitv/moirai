<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ChevronDown } from '@lucide/vue';
import type { LibraryQuerySort } from '@moirai/shared';
import FormDisclosure from '../FormDisclosure.vue';
import MediaSelectionReview from './MediaSelectionReview.vue';
import { playbackOrderLabel } from './playback-order-label';
import type { MediaSelectionProps, MediaSelectionEvents } from './media-selection';

const props = defineProps<MediaSelectionProps & { sourceType: string; querySort: LibraryQuerySort; sourceLabel: string; resetRevision: number }>();
const emit = defineEmits<MediaSelectionEvents>();
const open = ref(true);
const summary = computed(() => {
	if (props.sourceType === 'collection' || props.sourceType === 'ai') {
		return playbackOrderLabel(props.sort, props.sourceType === 'ai');
	}
	if (props.sourceType === 'library-query') {
		const field = props.querySort.type === 'name' ? 'Title / episode' : props.querySort.type === 'date-added' ? 'Indexed date' : 'Release date';
		return `${field} · ${props.querySort.direction === 'asc' ? 'Ascending' : 'Descending'}`;
	}

	return props.sourceType === 'item' ? props.sourceLabel || 'Exact item' : 'Season / episode · First to last';
});
watch(() => props.resetRevision, () => {
	open.value = true;
});
</script>

<template>
	<FormDisclosure v-model:open="open" class="program-playback-order">
		<template #summary><strong>Playback order</strong><span>{{ summary }}</span><ChevronDown class="form-disclosure-chevron" :size="20" aria-hidden="true" /></template>
		<p v-if="sourceType === 'collection'" class="program-order-explanation">
			Sequential follows this configured list. Date Added to Program follows addition order, which can differ from episode order. Choose Manual to arrange items yourself.
		</p>
		<p v-else-if="sourceType === 'ai'" class="program-order-explanation">Sequential follows the Order and Direction configured in the AI source above. Review results to inspect the selection.</p>
		<p v-else-if="sourceType === 'library-query'" class="program-order-explanation">Sequential follows the query order configured in the source above. Its preview shows that ordered selection as your library changes.</p>
		<p v-else-if="sourceType === 'item'" class="program-order-explanation">This program plays the exact selected item.</p>
		<p v-else class="program-order-explanation">Selected shows and seasons use their built-in season and episode order. Newly indexed episodes within the selected groups join automatically.</p>
		<MediaSelectionReview
			v-if="sourceType === 'collection'" v-bind="props" numbered
			@retry="emit('retry')" @remove-item="emit('removeItem', $event)" @remove-group="emit('removeGroup', $event)"
			@move-item="(id, offset) => emit('moveItem', id, offset)" @reorder-items="emit('reorderItems', $event)"
			@update:search="emit('update:search', $event)" @update:sort-type="emit('update:sortType', $event)"
			@update:sort-direction="emit('update:sortDirection', $event)"
		/>
	</FormDisclosure>
</template>
