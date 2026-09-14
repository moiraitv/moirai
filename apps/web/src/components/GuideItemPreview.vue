<script setup lang="ts">
import { nextTick, shallowRef } from 'vue';
import type { TimelineSegment } from '@moirai/shared';
import MediaCardPreview, { type MediaCardPreviewSource } from './MediaCardPreview.vue';

const active = shallowRef<{ segmentId: string; item: MediaCardPreviewSource; anchor: HTMLElement }>();
const preview = shallowRef<InstanceType<typeof MediaCardPreview>>();

/** Reuse the media-card preview for a single guide item without wrapping every timeline entry. */
async function show(segment: TimelineSegment, event: Event): Promise<void> {
	if (!segment.mediaItemId || !(event.currentTarget instanceof HTMLElement)) {
		close();
		return;
	}

	const target = {
		segmentId: segment.id,
		item: { id: segment.mediaItemId, title: segment.title, artworkUrl: null, year: null },
		anchor: event.currentTarget,
	};
	active.value = target;
	await nextTick();
	if (active.value !== target) {
		return;
	}

	if (event instanceof PointerEvent) {
		preview.value?.enter(event);
	}
	else {
		preview.value?.focus();
	}
}

/** Cancel pending hover work and dismiss the guide's current media preview. */
function close(): void {
	active.value = undefined;
}

defineExpose({ show, close });
</script>

<template>
	<MediaCardPreview
		v-if="active"
		:key="active.segmentId"
		ref="preview"
		:item="active.item"
		:external-anchor="active.anchor"
		hide-info
	/>
</template>
