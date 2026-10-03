<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Temporal } from '@js-temporal/polyfill';
import type { GuideEntry, TimelinePreview } from '@moirai/shared';
import { guideSegmentPercent, guideWindowMilliseconds } from '../../guide-geometry';
import { programColorStyle } from '../../program-colors';
import { instantLabel } from '../../time-format';
import { PREVIEW_FILLER_STAGES, previewFillerTicks, type PreviewFillerTick } from '../../preview-filler';
import GuideBlockPopover from '../GuideBlockPopover.vue';

const props = defineProps<{ preview: TimelinePreview | null }>();
const popover = ref<InstanceType<typeof GuideBlockPopover>>();
const windowStart = computed(() => props.preview
	? Temporal.PlainDate.from(props.preview.startDate).toZonedDateTime(props.preview.timeZone).epochMilliseconds : 0);
const windowMilliseconds = computed(() => props.preview
	? guideWindowMilliseconds(props.preview.startDate, props.preview.days, props.preview.timeZone) : 0);
const slotNumbers = computed(() => new Map([...new Set(props.preview?.segments.map(segment => segment.slotId))]
	.map((slotId, index) => [slotId, index + 1])));
const fillerTicks = computed(() => previewFillerTicks(props.preview));
const entries = computed(() => props.preview?.entries ?? props.preview?.segments.map((segment): GuideEntry => ({
	...segment, kind: 'item', description: '', segmentId: segment.id, occurrenceId: null,
})) ?? []);

/** Align entries and filler ticks on the same clipped elapsed-time axis. */
function entryStyle(entry: GuideEntry): Record<string, string> {
	const start = Math.max(windowStart.value, Date.parse(entry.start));
	const finish = Math.min(windowStart.value + windowMilliseconds.value, Date.parse(entry.finish));
	return { ...programColorStyle(entry.programId), left: `${(start - windowStart.value) / windowMilliseconds.value * 100}%`,
		width: `${guideSegmentPercent(new Date(start).toISOString(), new Date(Math.max(start, finish)).toISOString(), windowMilliseconds.value)}%` };
}

/** Format displayed guide boundaries in the preview's local time zone. */
function timeRange(entry: GuideEntry): string {
	const options = { hour: 'numeric', minute: '2-digit' } as const;
	return `${instantLabel(entry.start, options, props.preview?.timeZone)}–${instantLabel(entry.finish, options, props.preview?.timeZone)}`;
}

/** Describe the stage, local boundaries, and visible slot position for a filler marker. */
function fillerTickLabel(tick: PreviewFillerTick): string {
	const name = PREVIEW_FILLER_STAGES.find(stage => stage.kind === tick.stage)!.name;
	const options = { hour: 'numeric', minute: '2-digit', second: '2-digit' } as const;
	const slotIndex = slotNumbers.value.get(tick.slotId);
	return `${name}, ${instantLabel(tick.start, options, props.preview?.timeZone)}–${instantLabel(tick.finish, options, props.preview?.timeZone)}, slot ${slotIndex}`;
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
			:style="entryStyle(entry)"
			:title="entry.kind === 'block' ? undefined : `${entry.title} · ${timeRange(entry)}`"
			:aria-label="`${entry.title}, ${timeRange(entry)}`"
			@pointerenter="show(entry, $event)" @pointermove="entry.kind === 'block' && popover?.move($event, entry)" @pointerleave="popover?.leave()"
			@focus="show(entry, $event)" @focusout="popover?.leave()" @click="show(entry, $event, true)">
			<strong>{{ entry.title }}</strong>
			<small>{{ timeRange(entry) }}</small>
		</component>
	</div>
	<div v-if="fillerTicks.length" class="preview-filler-ticks" role="group" aria-label="Filler breaks">
		<span
			v-for="tick in fillerTicks" :key="tick.id" class="preview-filler-tick" :class="`stage-${tick.stage}`"
			:style="{ left: `${tick.left}%`, width: `${tick.width}%` }" :title="fillerTickLabel(tick)" :aria-label="fillerTickLabel(tick)" role="img"></span>
	</div>
	<GuideBlockPopover v-if="preview" ref="popover" :segments="preview.segments" :program-names="preview.programNames ?? {}" :time-zone="preview.timeZone" :selectable="false" />
</template>
