<script setup lang="ts">
import { AlertTriangle, Asterisk, Check, CircleHelp, MoreHorizontal } from '@lucide/vue';
import type { MediaBrowseEntry, MediaGroup } from '@moirai/shared';
import { useAttrs } from 'vue';
import { RouterLink } from 'vue-router';
import { artworkSrcset, artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';
import { mediaGroupSubtitle, mediaItemSubtitle } from '../../media-labels';
import MediaCardPreview from '../MediaCardPreview.vue';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
	entry: MediaBrowseEntry;
	libraryId: string;
	libraryType: string;
	selected: boolean;
	selectionMode: boolean;
}>();
const attrs = useAttrs();
const emit = defineEmits<{
	enter: [group: MediaGroup];
	toggle: [itemId: string];
}>();

/** Navigate into a media group. */
function activate(): void {
	if (props.entry.group) {
		emit('enter', props.entry.group);
	}
}

/** Toggle the item represented by the selection overlay. */
function toggleSelection(): void {
	if (props.entry.item) {
		emit('toggle', props.entry.item.id);
	}
}

/** Return the visible status label, leaving healthy items icon-only. */
function statusLabel(): string {
	if (!props.entry.item) {
		return '';
	}

	if (props.entry.item.availability !== 'available') {
		return 'Temporarily unavailable';
	}

	return props.entry.item.metadataStatus === 'incomplete'
		? 'Incomplete'
		: props.entry.item.metadataStatus === 'invalid' ? 'Invalid' : '';
}
</script>

<template>
	<component
		:is="entry.item ? MediaCardPreview : 'div'"
		v-bind="entry.item ? { item: entry.item } : {}"
		class="media-card-preview-trigger"
	>
		<component
			:is="entry.item ? RouterLink : 'button'"
			v-bind="attrs"
			class="media-card"
			:class="{ 'selectable-media-card': Boolean(entry.item), selected }"
			:to="entry.item ? `/libraries/${libraryId}/items/${entry.item.id}` : undefined"
			:type="entry.item ? undefined : 'button'"
			:tabindex="entry.item && selectionMode ? -1 : undefined"
			:aria-hidden="entry.item && selectionMode ? 'true' : undefined"
			@click="activate"
		>
			<span class="poster">
				<Asterisk class="poster-placeholder" :size="38" />
				<img v-if="entry.group?.artworkUrl" :src="artworkVariantUrl(entry.group.artworkUrl, 'card')" :srcset="artworkSrcset(entry.group.artworkUrl, 'card')" :alt="`${entry.group.title} artwork`" loading="lazy" decoding="async" @error="hideBrokenImage" />
				<img v-else-if="entry.item?.artworkUrl" :src="artworkVariantUrl(entry.item.artworkUrl, 'card')" :srcset="artworkSrcset(entry.item.artworkUrl, 'card')" :alt="`${entry.item.title} artwork`" loading="lazy" decoding="async" @error="hideBrokenImage" />
			</span>
			<span v-if="entry.group" class="media-card-copy"><span class="media-card-title">{{ entry.group.title }}</span><span class="media-card-subtitle">{{ mediaGroupSubtitle(libraryType, entry.group) || entry.group.kind }}</span><MoreHorizontal class="card-menu-icon" :size="16" /></span>
			<span v-else-if="entry.item" class="media-card-copy"><span class="media-card-title">{{ entry.item.title }}</span><span class="media-card-subtitle">{{ mediaItemSubtitle(libraryType, entry.item) || entry.item.kind }}</span><span class="media-card-status" :data-status="entry.item.metadataStatus" :data-availability="entry.item.availability" :title="entry.item.availability === 'available' ? `Metadata: ${entry.item.metadataStatus}` : 'Media temporarily unavailable'"><CircleHelp v-if="entry.item.availability !== 'available'" :size="14" /><AlertTriangle v-else-if="entry.item.metadataStatus !== 'complete'" :size="14" /><Check v-else :size="14" /><small v-if="statusLabel()">{{ statusLabel() }}</small></span></span>
		</component>
		<button
			v-if="entry.item"
			type="button"
			class="media-selection-control"
			:aria-pressed="selected"
			:aria-label="`${selected ? 'Deselect' : 'Select'} ${entry.item.title}`"
			@click="toggleSelection"
		>
			<span class="media-selection-check"><Check v-if="selected" :size="16" /></span>
		</button>
	</component>
</template>
