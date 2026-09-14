<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { TvMinimal } from '@lucide/vue';
import type { Channel, GuideEntry, GuideSegmentDetail, ScheduleGuide, TimelineSegment } from '@moirai/shared';
import { api } from '../api';
import { channelLogoUrl } from '../channel-logo';
import { dateKey, formatDateKey } from '../date-key';
import { errorMessage } from '../error-message';
import {
	guideDayGeometry,
	guideInstantPosition,
	guideSegmentWidth,
} from '../guide-geometry';
import { channelGuideRows } from '../channel-groups';
import { guideSourceLabel } from '../guide-source';
import { programColorStyle } from '../program-colors';
import GuideSegmentPreviewModal from './GuideSegmentPreviewModal.vue';
import ScheduleWarningBadge from './ScheduleWarningBadge.vue';
import GuideBlockPopover from './GuideBlockPopover.vue';
import GuideItemPreview from './GuideItemPreview.vue';

const props = withDefaults(
	defineProps<{
		channels: Channel[];
		guide: ScheduleGuide | null;
		timeZone: string;
		startDate: string;
		days?: number;
		emptyMessage?: string;
		showTechnicalDetails?: boolean;
	}>(),
	{ days: 7, emptyMessage: 'No schedule assigned', showTechnicalDetails: false },
);

defineSlots<{
	detail(props: {
		channel: Channel;
		preview: ScheduleGuide['channels'][number]['preview'] | undefined;
	}): unknown;
	actions(props: { channel: Channel }): unknown;
}>();

const guideScroll = ref<HTMLElement>();
const blockPopover = ref<InstanceType<typeof GuideBlockPopover>>();
const itemPreview = ref<InstanceType<typeof GuideItemPreview>>();
const programNames = computed(() => Object.assign({}, ...(props.guide?.channels.map(channel => channel.preview.programNames ?? {}) ?? [])) as Record<string, string>);
const actualSegments = computed(() => props.guide?.channels.flatMap((channel) => channel.preview.segments) ?? []);
const segmentsById = computed(() => new Map(actualSegments.value.map(segment => [segment.id, segment])));
const displayedByChannel = computed(() => new Map((props.guide?.channels ?? []).map((channel) =>
	[channel.channelId, channel.entries ?? channel.preview.segments])));
const selectedDetail = ref<GuideSegmentDetail | null>(null);
const selectedLoading = ref(false);
const selectedError = ref('');
const detailCache = new Map<string, GuideSegmentDetail>();
let detailRequest = 0;
/** Pixels per elapsed hour shared by the Guide and Channels timelines. */
const HOUR_WIDTH = 112;
const daysGeometry = computed(() =>
	guideDayGeometry(props.startDate, props.days, props.timeZone, HOUR_WIDTH));
const timelineWidth = computed(() => {
	const finalDay = daysGeometry.value.at(-1);
	return finalDay ? finalDay.left + finalDay.width : 0;
});
const accessibleLabel = computed(() =>
	props.days === 7 ? 'Seven-day channel guide' : `${props.days}-day channel guide`);
const guideByChannel = computed(
	() => new Map((props.guide?.channels ?? []).map((entry) => [entry.channelId, entry.preview])),
);

const guideRows = computed(() => channelGuideRows(props.channels));

/** Format a wall-clock hour using the viewer's preferred hour cycle. */
function displayHour(hour: number): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(2026, 0, 1, hour)));
}

const visibleDays = computed(() =>
	props.startDate
		? daysGeometry.value.map((geometry) => {
			const key = geometry.key;
			return {
				...geometry,
				key,
				weekday: formatDateKey(key, { weekday: 'short' }),
				date: formatDateKey(key, { month: 'short', day: 'numeric' }),
			};
		})
		: []);

const currentTimeLeft = computed(() => {
	const now = new Date();
	const today = dateKey(now, props.timeZone);
	const dayIndex = visibleDays.value.findIndex((day) => day.key === today);
	if (dayIndex < 0) {
		return null;
	}

	return guideInstantPosition(now.toISOString(), daysGeometry.value, HOUR_WIDTH);
});

/** Convert an instant to its horizontal position on the elapsed-time guide axis. */
function localTimelinePosition(value: string): number {
	return guideInstantPosition(value, daysGeometry.value, HOUR_WIDTH);
}

/** Position and color a guide segment from its absolute playback interval and program identity. */
function segmentStyle(segment: Pick<TimelineSegment, 'start' | 'finish' | 'programId'>): Record<string, string> {
	return {
		left: `${localTimelinePosition(segment.start)}px`,
		width: `${guideSegmentWidth(segment.start, segment.finish, HOUR_WIDTH)}px`,
		...programColorStyle(segment.programId),
	};
}

/** Open grouped listings without sending their presentation IDs to the media endpoint. */
function openEntry(entry: TimelineSegment | GuideEntry, event: Event, focus = false): void {
	if ('kind' in entry && entry.kind === 'block') {
		itemPreview.value?.close();
		void blockPopover.value?.show(
			entry,
			event.currentTarget as HTMLElement,
			focus,
			event instanceof MouseEvent && (event.type.startsWith('pointer') || event.detail > 0) ? event.clientX : undefined,
		);
	}
	else {
		const segment = 'segmentId' in entry
			? segmentsById.value.get(entry.segmentId ?? '') : entry;
		if (event.type === 'click') {
			itemPreview.value?.close();
			if (segment) {
				void openSegment(segment);
			}
		}
		else if (segment) {
			void itemPreview.value?.show(segment, event);
		}
	}
}

/** Dismiss an item hover and retain the grouped listing's existing leave behavior. */
function leaveEntry(): void {
	itemPreview.value?.close();
	blockPopover.value?.leave();
}

/** Load and display safe metadata for one committed guide segment. */
async function openSegment(segment: TimelineSegment): Promise<void> {
	const request = ++detailRequest;
	selectedError.value = '';
	const cached = detailCache.get(segment.id);
	if (cached) {
		selectedDetail.value = cached;
		selectedLoading.value = false;
		return;
	}

	selectedDetail.value = null;
	selectedLoading.value = true;
	try {
		const detail = await api.guideSegment(segment.channelId, segment.id);
		if (request !== detailRequest) {
			return;
		}

		detailCache.set(segment.id, detail);
		selectedDetail.value = detail;
	}
	catch (cause) {
		if (request === detailRequest) {
			selectedError.value = errorMessage(cause);
		}
	}
	finally {
		if (request === detailRequest) {
			selectedLoading.value = false;
		}
	}
}

/** Close the guide preview and ignore any request still in flight. */
function closeSegment(): void {
	detailRequest += 1;
	selectedDetail.value = null;
	selectedError.value = '';
	selectedLoading.value = false;
}

/** Reveal the current-time position with leading context, or return to the guide start. */
function scrollToCurrentTime(): void {
	const scroller = guideScroll.value;
	if (!scroller) {
		return;
	}

	const target = currentTimeLeft.value;
	scroller.scrollLeft = target === null ? 0 : Math.max(0, target - scroller.clientWidth * 0.3);
}

watch(
	() => [props.startDate, props.guide] as const,
	async () => {
		detailCache.clear();
		closeSegment();
		blockPopover.value?.close();
		await nextTick();
		scrollToCurrentTime();
	},
);
onMounted(() => scrollToCurrentTime());
</script>

<template>
	<div class="guide-frame">
		<div ref="guideScroll" class="guide-scroll" :aria-label="accessibleLabel">
			<div
				class="guide-canvas"
				:style="{
					'--guide-hour-width': `${HOUR_WIDTH}px`,
					'--guide-timeline-width': `${timelineWidth}px`,
				}"
			>
				<div class="guide-corner"><TvMinimal :size="18" />Channels</div>
				<div class="guide-time-header">
					<div
						v-for="day in visibleDays"
						:key="day.key"
						class="guide-day-heading"
						:class="{ today: day.key === dateKey(new Date(), timeZone) }"
						:style="{ left: `${day.left}px`, width: `${day.width}px` }"
					>
						<strong>{{ day.weekday }}</strong
						><span>{{ day.date }}</span>
						<small
							v-for="tick in day.ticks"
							:key="tick.hour"
							:style="{ left: `${tick.left}px` }"
						>{{ displayHour(tick.hour) }}</small
						>
					</div>
					<span
						v-if="currentTimeLeft !== null"
						class="current-time-line"
						:style="{ left: `${currentTimeLeft}px` }"
					></span>
				</div>
				<template v-for="row in guideRows" :key="row.key">
					<template v-if="row.type === 'family'">
						<div class="guide-family-cell">{{ row.label }}</div>
						<div class="guide-family-track" aria-hidden="true"></div>
					</template>
					<template v-else>
						<template v-for="channel in [row.channel]" :key="channel.id">
							<article class="guide-channel-cell">
								<div class="guide-channel-identity">
									<img
										v-if="channelLogoUrl(channel)"
										class="guide-channel-logo"
										:src="channelLogoUrl(channel) ?? undefined"
										alt=""
									/>
									<span v-else class="guide-channel-logo"><TvMinimal :size="24" aria-hidden="true" /></span>
									<span class="channel-number">{{ channel.number }}</span>
								</div>
								<div class="guide-channel-copy">
									<h2>{{ channel.name }}</h2>
									<p v-if="showTechnicalDetails">
										{{ channel.video.width }}×{{ channel.video.height }}
										{{ channel.video.format?.toUpperCase() }} ·
										{{ channel.audio.format?.toUpperCase() }}
									</p>
									<slot name="detail" :channel="channel" :preview="guideByChannel.get(channel.id)"></slot>
									<ScheduleWarningBadge
										:issues="guideByChannel.get(channel.id)?.issues ?? []"
										:channel-id="channel.id"
										:time-zone="timeZone"
									/>
								</div>
								<div v-if="$slots.actions" class="guide-channel-actions">
									<slot name="actions" :channel="channel"></slot>
								</div>
							</article>
							<div class="guide-channel-track">
								<span
									v-for="day in visibleDays.slice(1)"
									:key="day.key"
									class="guide-day-boundary"
									:style="{ left: `${day.left}px` }"
								></span>
								<component
									:is="'kind' in segment && segment.kind === 'block' ? 'div' : 'button'"
									v-for="segment in displayedByChannel.get(channel.id) ?? []"
									:key="segment.id"
									type="button"
									class="guide-programme"
									:data-program-id="segment.programId"
									:class="[`role-${segment.role}`, { truncated: segment.truncated, 'guide-block': 'kind' in segment && segment.kind === 'block' }]"
									:style="segmentStyle(segment)"
									:aria-label="`${segment.title}, ${segment.start} – ${segment.finish}`"
									@click="openEntry(segment, $event, true)"
									@pointerenter="openEntry(segment, $event)"
									@pointermove="'kind' in segment && segment.kind === 'block' && blockPopover?.move($event, segment)"
									@focusin="openEntry(segment, $event)"
									@pointerleave="leaveEntry"
									@focusout="leaveEntry"
								>
									<component
										:is="'kind' in segment && segment.kind === 'block' ? 'button' : 'span'"
										:class="{ 'guide-block-copy': 'kind' in segment && segment.kind === 'block' }">
										<strong>{{
											segment.role === 'dead-air' ? 'No programming' : segment.title
										}}</strong>
										<small
										>{{ 'kind' in segment && segment.kind === 'block' ? 'Slot' : guideSourceLabel(segment, programNames)
										}}<template v-if="segment.truncated"> · truncated</template></small
										>
									</component>
								</component>
								<div
									v-if="!guideByChannel.get(channel.id)"
									class="guide-empty-day"
									:style="{ left: '8px', width: `${timelineWidth - 16}px` }"
								>
									<span>{{ emptyMessage }}</span>
								</div>
								<span
									v-if="currentTimeLeft !== null"
									class="current-time-line"
									:style="{ left: `${currentTimeLeft}px` }"
								></span>
							</div>
						</template>
					</template>
				</template>
			</div>
		</div>
	</div>
	<GuideItemPreview ref="itemPreview" />
	<GuideBlockPopover ref="blockPopover" :segments="actualSegments" :program-names="programNames" :time-zone="timeZone" @select="openSegment" />
	<GuideSegmentPreviewModal
		v-if="selectedLoading || selectedDetail || selectedError"
		:detail="selectedDetail"
		:loading="selectedLoading"
		:error="selectedError"
		:time-zone="timeZone"
		@close="closeSegment"
	/>
</template>
