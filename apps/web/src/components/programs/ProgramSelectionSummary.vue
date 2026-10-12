<script setup lang="ts">
import { computed, ref } from 'vue';
import { Asterisk } from '@lucide/vue';
import { artworkSrcset, artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';
import type { MediaSelectionProps } from './media-selection';

const props = defineProps<MediaSelectionProps>();
const emit = defineEmits<{ review: [] }>();
const button = ref<HTMLButtonElement>();
const selections = computed(() => props.selectingGroups ? props.groups : props.items);
const missing = computed(() => props.selectingGroups ? props.missingGroupCount : props.missingItemCount);

/** Restore focus to the control that opened the selection drawer. */
function focus(): void {
	button.value?.focus();
}
defineExpose({ focus });
</script>

<template>
	<div class="selected-collection-summary">
		<div class="selected-collection-copy">
			<strong>{{ selectionCount }} selected</strong>
			<small v-if="loading && !loaded">Loading selection…</small>
			<small v-else-if="!loaded">Could not load selection</small>
			<small v-else-if="missing > 0" class="availability-warning">{{ missing }} no longer indexed · references preserved</small>
			<small v-else>Maximum {{ selectionLimit }}</small>
		</div>
		<div class="selected-collection-actions">
			<div v-if="selections.length" class="selected-poster-stack" aria-hidden="true">
				<span v-for="selection in selections.slice(0, 4)" :key="selection.id">
					<span class="source-artwork-placeholder"><Asterisk :size="14" /></span>
					<img
						v-if="selection.artworkUrl" :src="artworkVariantUrl(selection.artworkUrl, 'thumb')"
						:srcset="artworkSrcset(selection.artworkUrl, 'thumb')" alt="" @error="hideBrokenImage" />
				</span>
				<b v-if="selectionCount > 4">+{{ selectionCount - 4 }}</b>
			</div>
			<button ref="button" type="button" class="toolbar-button selected-review-button" :disabled="selectionCount === 0" @click="emit('review')">Review Selection</button>
		</div>
	</div>
</template>
