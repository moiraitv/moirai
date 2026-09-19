<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
	guideSpanOverlapsRange,
} from '../guide-geometry';
import { channelGuideRows } from '../channel-groups';
import { guideSourceLabel } from '../guide-source';
import { programColorStyle } from '../program-colors';
import { artworkSrcset, artworkVariantUrl } from '../artwork-url';
import {
	guideListingThumb,
	guideListingTimespan,
	guideListingVisualWidth,
	guideListingWashUrl,
} from '../guide-listing-layout';
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
		hourWidth?: number | null;
		visibleHours?: number;
		useEntryTitles?: boolean;
		inspectListings?: boolean;
		subtitleMode?: 'source' | 'listing';
		listingPresentation?: 'default' | 'guide';
	}>(),
	{
		days: 7,
		emptyMessage: 'No schedule assigned',
		showTechnicalDetails: false,
		hourWidth: null,
		visibleHours: 6,
		useEntryTitles: false,
		inspectListings: false,
		subtitleMode: 'source',
		listingPresentation: 'default',
	},
);

const emit = defineEmits<{
	inspect: [payload: { id: string; target: HTMLElement }];
}>();

defineSlots<{
	detail(props: {
		channel: Channel;
		preview: ScheduleGuide['channels'][number]['preview'] | undefined;
	}): unknown;
	actions(props: { channel: Channel }): unknown;
}>();

const guideScroll = ref<HTMLElement>();
const centerNow = ref(false);
const blockPopover = ref<InstanceType<typeof GuideBlockPopover>>();
const itemPreview = ref<InstanceType<typeof GuideItemPreview>>();
const programNames = computed(() => Object.assign({}, ...(props.guide?.channels.map(channel => channel.preview.programNames ?? {}) ?? [])) as Record<string, string>);
const actualSegments = computed(() => props.guide?.channels.flatMap((channel) => channel.preview.segments) ?? []);
const segmentsById = computed(() => new Map(actualSegments.value.map(segment => [segment.id, segment])));
const displayedByChannel = computed(() => new Map((props.guide?.channels ?? []).map((channel) =>
	[channel.channelId, channel.entries ?? channel.preview.segments])));
/** Extra hours rendered beyond the scrolled viewport so scrolling does not flash empty track. */
const GUIDE_OVERSCAN_HOURS = 2;
const viewportStart = ref(0);
const viewportEnd = ref(Number.POSITIVE_INFINITY);
const pinnedProgrammeId = ref<string | null>(null);
const selectedDetail = ref<GuideSegmentDetail | null>(null);
const selectedLoading = ref(false);
const selectedError = ref('');
const detailCache = new Map<string, GuideSegmentDetail>();
let detailRequest = 0;
const trackWidth = ref(0);
const hourWidth = computed(() => {
	if (props.hourWidth != null) {
		return props.hourWidth;
	}

	return trackWidth.value > 0 ? Math.max(48, trackWidth.value / props.visibleHours) : 112;
});
const daysGeometry = computed(() =>
	guideDayGeometry(props.startDate, props.days, props.timeZone, hourWidth.value));
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
const positionedByChannel = computed(() => {
	const days = daysGeometry.value;
	const result = new Map<string, Array<{
		programme: TimelineSegment | GuideEntry;
		left: number;
		right: number;
	}>>();
	for (const [channelId, programmes] of displayedByChannel.value) {
		result.set(channelId, programmes.map((programme) => {
			const left = guideInstantPosition(programme.start, days, hourWidth.value);
			return {
				programme,
				left,
				right: left + guideSegmentWidth(programme.start, programme.finish, hourWidth.value),
			};
		}));
	}

	return result;
});
const visibleByChannel = computed(() => {
	const rangeStart = viewportStart.value;
	const rangeEnd = viewportEnd.value;
	const pinned = pinnedProgrammeId.value;
	const result = new Map<string, Array<TimelineSegment | GuideEntry>>();
	for (const [channelId, programmes] of positionedByChannel.value) {
		result.set(
			channelId,
			programmes
				.filter((entry) =>
					entry.programme.id === pinned
					|| guideSpanOverlapsRange(entry.left, entry.right, rangeStart, rangeEnd))
				.map((entry) => entry.programme),
		);
	}

	return result;
});
let viewportFrame = 0;
let viewportObserver: ResizeObserver | null = null;

/** Read the scrolled timeline window and quantize it to hour-sized buckets. */
function readViewport(): void {
	const scroller = guideScroll.value;
	if (!scroller || scroller.clientWidth === 0) {
		return;
	}

	const channelWidth = scroller.querySelector<HTMLElement>('.guide-corner')?.offsetWidth ?? 0;
	const unit = hourWidth.value;
	const overscan = unit * GUIDE_OVERSCAN_HOURS;
	const start = Math.floor((scroller.scrollLeft - channelWidth - overscan) / unit) * unit;
	const end = Math.ceil(
		(scroller.scrollLeft + scroller.clientWidth - channelWidth + overscan) / unit,
	) * unit;
	if (viewportStart.value !== start) {
		viewportStart.value = start;
	}
	if (viewportEnd.value !== end) {
		viewportEnd.value = end;
	}
}

/** Size the elapsed-hour scale so the requested period fills the visible track. */
function measureTrack(): void {
	const scroller = guideScroll.value;
	if (!scroller) {
		return;
	}

	const channelWidth = scroller.querySelector<HTMLElement>('.guide-corner')?.offsetWidth ?? 0;
	const next = Math.max(0, scroller.clientWidth - channelWidth);
	if (trackWidth.value !== next) {
		trackWidth.value = next;
	}
}

/** Coalesce scroll and resize measurements to one animation frame. */
function scheduleViewportRead(): void {
	if (viewportFrame !== 0) {
		return;
	}

	viewportFrame = requestAnimationFrame(() => {
		viewportFrame = 0;
		measureTrack();
		readViewport();
	});
}

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

	return guideInstantPosition(now.toISOString(), daysGeometry.value, hourWidth.value);
});

/** Convert an instant to its horizontal position on the elapsed-time guide axis. */
function localTimelinePosition(value: string): number {
	return guideInstantPosition(value, daysGeometry.value, hourWidth.value);
}

/** Position and color a guide segment from its absolute playback interval and program identity. */
function segmentStyle(segment: Pick<TimelineSegment, 'start' | 'finish' | 'programId'>): Record<string, string> {
	const span = guideSegmentWidth(segment.start, segment.finish, hourWidth.value);
	const visual = props.listingPresentation === 'guide' ? guideListingVisualWidth(span) : span;

	return {
		left: `${localTimelinePosition(segment.start) + (span - visual) / 2}px`,
		width: `${visual}px`,
		...programColorStyle(segment.programId),
	};
}

/** Read a template-rendered subtitle when the listing was presented from XMLTV. */
function listingSubtitle(segment: TimelineSegment | GuideEntry): string {
	return 'subtitle' in segment && typeof segment.subtitle === 'string' ? segment.subtitle : '';
}

/** Choose a left thumbnail that leaves enough room for listing text. */
function listingThumb(segment: TimelineSegment | GuideEntry): ReturnType<typeof guideListingThumb> {
	if (props.listingPresentation !== 'guide' || ('kind' in segment && segment.kind === 'block')) {
		return null;
	}

	return guideListingThumb(
		guideListingVisualWidth(guideSegmentWidth(segment.start, segment.finish, hourWidth.value)),
		segment.landscapeUrl,
		segment.posterUrl,
	);
}

/** Choose right-side wash art, using landscape when the item has no fanart file. */
function listingWash(segment: TimelineSegment | GuideEntry): string | null {
	if (props.listingPresentation !== 'guide' || ('kind' in segment && segment.kind === 'block')) {
		return null;
	}

	return guideListingWashUrl(segment.fanartUrl, segment.landscapeUrl);
}

/** Open the Liquid-value inspector from a preview channel cell. */
function inspectChannel(event: MouseEvent): void {
	if (props.inspectListings && event.currentTarget instanceof HTMLElement) {
		emit('inspect', { id: 'channel', target: event.currentTarget });
	}
}

/** Open grouped listings without sending their presentation IDs to the media endpoint. */
function openEntry(entry: TimelineSegment | GuideEntry, event: Event, focus = false): void {
	if (props.inspectListings) {
		if (event.type === 'click' && event.currentTarget instanceof HTMLElement) {
			pinnedProgrammeId.value = entry.id;
			emit('inspect', { id: entry.id, target: event.currentTarget });
		}
		return;
	}

	pinnedProgrammeId.value = entry.id;
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
	if (centerNow.value) {
		centerCurrentTime();
		return;
	}

	const scroller = guideScroll.value;
	if (!scroller) {
		return;
	}

	const target = currentTimeLeft.value;
	scroller.scrollLeft = target === null ? 0 : Math.max(0, target - scroller.clientWidth * 0.3);
}

/** Center the now line within the timeline area beside the pinned channel column. */
function centerCurrentTime(): void {
	centerNow.value = true;
	const scroller = guideScroll.value;
	const target = currentTimeLeft.value;
	if (!scroller || target === null) {
		return;
	}

	const channelWidth = scroller.querySelector<HTMLElement>('.guide-corner')?.offsetWidth ?? 0;
	scroller.scrollLeft = Math.max(0, target - (scroller.clientWidth - channelWidth) / 2);
}

defineExpose({ centerCurrentTime });

watch(
	() => [props.startDate, props.guide, hourWidth.value] as const,
	async ([startDate, , width], previous) => {
		const startChanged = !previous || previous[0] !== startDate;
		const zoomChanged = Boolean(previous) && previous[2] !== width;
		if (startChanged) {
			centerNow.value = false;
			detailCache.clear();
			closeSegment();
			blockPopover.value?.close();
		}

		await nextTick();
		if (startChanged || zoomChanged) {
			scrollToCurrentTime();
		}

		readViewport();
	},
);
onMounted(() => {
	measureTrack();
	scrollToCurrentTime();
	readViewport();
	guideScroll.value?.addEventListener('scroll', scheduleViewportRead, { passive: true });
	viewportObserver = new ResizeObserver(() => {
		scheduleViewportRead();
	});
	if (guideScroll.value) {
		viewportObserver.observe(guideScroll.value);
	}
});
onBeforeUnmount(() => {
	guideScroll.value?.removeEventListener('scroll', scheduleViewportRead);
	viewportObserver?.disconnect();
	viewportObserver = null;
	if (viewportFrame !== 0) {
		cancelAnimationFrame(viewportFrame);
		viewportFrame = 0;
	}
});
</script>

<template>
	<div class="guide-frame" :class="{ 'guide-frame-page': listingPresentation === 'guide' }">
		<div ref="guideScroll" class="guide-scroll" :aria-label="accessibleLabel">
			<div
				class="guide-canvas"
				:style="{
					'--guide-hour-width': `${hourWidth}px`,
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
							<article
								class="guide-channel-cell"
								:class="{ 'guide-channel-inspect': inspectListings, 'guide-channel-cell-page': listingPresentation === 'guide' }"
								@click="inspectChannel($event)"
							>
								<template v-if="listingPresentation === 'guide'">
									<span class="channel-number">{{ channel.number }}</span>
									<img
										v-if="channelLogoUrl(channel)"
										class="guide-channel-logo"
										:src="channelLogoUrl(channel) ?? undefined"
										alt=""
									/>
									<span v-else class="guide-channel-logo"><TvMinimal :size="36" aria-hidden="true" /></span>
								</template>
								<div v-else class="guide-channel-identity">
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
									v-for="segment in visibleByChannel.get(channel.id) ?? []"
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
									<img
										v-if="listingWash(segment)"
										class="guide-programme-fanart"
										:src="artworkVariantUrl(listingWash(segment), 'card')"
										:srcset="artworkSrcset(listingWash(segment), 'card')"
										alt=""
										loading="lazy"
										decoding="async"
									/>
									<img
										v-if="listingThumb(segment)"
										class="guide-programme-thumb"
										:class="`guide-programme-thumb-${listingThumb(segment)!.kind}`"
										:src="artworkVariantUrl(listingThumb(segment)!.url, 'card')"
										:srcset="artworkSrcset(listingThumb(segment)!.url, 'card')"
										alt=""
										loading="lazy"
										decoding="async"
									/>
									<component
										:is="'kind' in segment && segment.kind === 'block' ? 'button' : 'span'"
										class="guide-programme-copy"
										:class="{ 'guide-block-copy': 'kind' in segment && segment.kind === 'block' }">
										<strong>{{
											useEntryTitles || segment.role !== 'dead-air' ? segment.title : 'No programming'
										}}</strong>
										<small
											v-if="subtitleMode === 'source' || listingSubtitle(segment) || segment.truncated"
										>{{
											subtitleMode === 'source'
												? ('kind' in segment && segment.kind === 'block' ? 'Slot' : guideSourceLabel(segment, programNames))
												: listingSubtitle(segment)
										}}<template v-if="segment.truncated">{{
											subtitleMode === 'source' || listingSubtitle(segment) ? ' · truncated' : 'truncated'
										}}</template></small
										>
										<small v-if="listingPresentation === 'guide'" class="guide-programme-timespan">{{
											guideListingTimespan(segment.start, segment.finish, timeZone)
										}}</small>
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
