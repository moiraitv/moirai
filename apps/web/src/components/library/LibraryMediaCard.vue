<script setup lang="ts">
import { Asterisk, Check, CircleHelp, MoreHorizontal } from '@lucide/vue';
import type { MediaBrowseEntry, MediaGroup } from '@moirai/shared';
import { RouterLink } from 'vue-router';
import { artworkSrcset, artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';
import { mediaGroupSubtitle, mediaItemSubtitle } from '../../media-labels';

const props = defineProps<{
	entry: MediaBrowseEntry;
	libraryId: string;
	libraryType: string;
	selectionMode: boolean;
	selected: boolean;
}>();
const emit = defineEmits<{
	enter: [group: MediaGroup];
	toggle: [itemId: string];
}>();

/** Navigate into groups or toggle an item while the catalog is in selection mode. */
function activate(): void {
	if (props.entry.group) {
		emit('enter', props.entry.group);
	}
	else if (props.entry.item && props.selectionMode) {
		emit('toggle', props.entry.item.id);
	}
}
</script>

<template>
	<component
		:is="entry.item && !selectionMode ? RouterLink : 'button'"
		class="media-card"
		:class="{ 'selectable-media-card': Boolean(entry.item && selectionMode), selected }"
		:to="entry.item && !selectionMode ? `/libraries/${libraryId}/items/${entry.item.id}` : undefined"
		:type="entry.item && !selectionMode ? undefined : 'button'"
		:aria-pressed="entry.item && selectionMode ? selected : undefined"
		:aria-label="entry.item && selectionMode ? `${selected ? 'Deselect' : 'Select'} ${entry.item.title}` : undefined"
		@click="activate"
	>
		<span v-if="entry.item && selectionMode" class="media-selection-check"><Check v-if="selected" :size="16" /></span>
		<span class="poster">
			<Asterisk class="poster-placeholder" :size="38" />
			<img v-if="entry.group?.artworkUrl" :src="artworkVariantUrl(entry.group.artworkUrl, 'card')" :srcset="artworkSrcset(entry.group.artworkUrl, 'card')" :alt="`${entry.group.title} artwork`" loading="lazy" decoding="async" @error="hideBrokenImage" />
			<img v-else-if="entry.item?.artworkUrl" :src="artworkVariantUrl(entry.item.artworkUrl, 'card')" :srcset="artworkSrcset(entry.item.artworkUrl, 'card')" :alt="`${entry.item.title} artwork`" loading="lazy" decoding="async" @error="hideBrokenImage" />
		</span>
		<span v-if="entry.group" class="media-card-copy"><span class="media-card-title">{{ entry.group.title }}</span><span class="media-card-subtitle">{{ mediaGroupSubtitle(libraryType, entry.group) || entry.group.kind }}</span><MoreHorizontal class="card-menu-icon" :size="16" /></span>
		<span v-else-if="entry.item" class="media-card-copy"><span class="media-card-title">{{ entry.item.title }}</span><span class="media-card-subtitle">{{ mediaItemSubtitle(libraryType, entry.item) || entry.item.kind }}</span><small v-if="entry.item.availability !== 'available'" class="availability-warning">Temporarily unavailable</small><MoreHorizontal v-if="!selectionMode" class="card-menu-icon" :size="16" /><span class="metadata-indicator" :data-status="entry.item.metadataStatus" :data-availability="entry.item.availability" :title="entry.item.availability === 'available' ? `Metadata: ${entry.item.metadataStatus}` : 'Media temporarily unavailable'"><CircleHelp v-if="entry.item.availability !== 'available'" :size="11" /><Check v-else :size="10" /></span></span>
	</component>
</template>
