<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GuideEntry, TimelinePreview } from '@moirai/shared';
import { guideSegmentPercent, guideWindowMilliseconds } from '../../guide-geometry';
import { programColorStyle } from '../../program-colors';
import { instantLabel } from '../../time-format';
import GuideBlockPopover from '../GuideBlockPopover.vue';

const props = defineProps<{ preview: TimelinePreview | null }>();
const popover = ref<InstanceType<typeof GuideBlockPopover>>();
const windowMilliseconds = computed(() => props.preview
	? guideWindowMilliseconds(props.preview.startDate, props.preview.days, props.preview.timeZone) : 0);
const entries = computed(() => props.preview?.entries ?? props.preview?.segments.map((segment): GuideEntry => ({
	...segment, kind: 'item', description: '', segmentId: segment.id, occurrenceId: null,
})) ?? []);

/** Format displayed guide boundaries in the preview's local time zone. */
function timeRange(entry: GuideEntry): string {
	const options = { hour: 'numeric', minute: '2-digit' } as const;
	return `${instantLabel(entry.start, options, props.preview?.timeZone)}–${instantLabel(entry.finish, options, props.preview?.timeZone)}`;
}

/** Open actual draft items without requesting details from the committed timeline. */
function show(entry: GuideEntry, event: Event, focus = false): void {
	if (entry.kind === 'block') {
		void popover.value?.show(
			entry,
			event.currentTarget as HTMLElement,
			focus,
			event instanceof MouseEvent && (event.type.startsWith('pointer') || event.detail > 0) ? event.clientX : undefined,
		);
	}
}

watch(() => props.preview, () => popover.value?.close());
</script>

<template>
	<div class="resolved-track" :class="{ 'is-placeholder': !preview }">
		<component
			:is="entry.kind === 'block' ? 'button' : 'div'"
			v-for="entry in entries" :key="entry.id"
			:type="entry.kind === 'block' ? 'button' : undefined"
			class="resolved-segment" :data-program-id="entry.programId"
			:class="[`role-${entry.role}`, { truncated: entry.truncated, 'resolved-guide-block': entry.kind === 'block' }]"
			:style="{ ...programColorStyle(entry.programId), width: `${guideSegmentPercent(entry.start, entry.finish, windowMilliseconds)}%` }"
			:title="entry.kind === 'block' ? undefined : `${entry.title} · ${timeRange(entry)}`"
			:aria-label="`${entry.title}, ${timeRange(entry)}`"
			@pointerenter="show(entry, $event)" @pointermove="entry.kind === 'block' && popover?.move($event, entry)" @pointerleave="popover?.leave()"
			@focus="show(entry, $event)" @focusout="popover?.leave()" @click="show(entry, $event, true)">
			<strong>{{ entry.title }}</strong>
			<small>{{ timeRange(entry) }}</small>
		</component>
	</div>
	<GuideBlockPopover v-if="preview" ref="popover" :segments="preview.segments" :program-names="preview.programNames ?? {}" :time-zone="preview.timeZone" :selectable="false" />
</template>
