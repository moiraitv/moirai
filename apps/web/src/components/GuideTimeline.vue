<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { TvMinimal } from '@lucide/vue';
import type { Channel, GuideEntry, GuideSegmentDetail, ScheduleGuide, TimelineSegment } from '@moirai/shared';
import { api } from '../api';
import { guideIntervalIndex } from '../guide-index';
import { useGuideRows } from '../composables/useGuideRows';
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
const activeChannelId = ref<string | null>(null);
const activeSegments = computed(() => props.guide?.channels.find(channel => channel.channelId === activeChannelId.value)?.preview.segments ?? []);
const displayedByChannel = computed(() => new Map((props.guide?.channels ?? []).map((channel) =>
	[channel.channelId, channel.entries ?? channel.preview.segments])));
/** Extra hours rendered beyond the scrolled viewport so scrolling does not flash empty track. */
const GUIDE_OVERSCAN_HOURS = 2;
const viewportStart = ref(0);
const viewportEnd = ref(0);
const viewportReady = ref(false);
const pinnedProgramme = shallowRef<TimelineSegment | GuideEntry | null>(null);
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
const calendarGeometry = computed(() =>
	props.startDate ? guideDayGeometry(props.startDate, props.days, props.timeZone, 1) : []);
const daysGeometry = computed(() => calendarGeometry.value.map(day => ({
	...day, left: day.left * hourWidth.value, width: day.width * hourWidth.value,
	ticks: day.ticks.map(tick => ({ ...tick, left: tick.left * hourWidth.value })),
})));
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
const { body: rowsBody, visibleRows, height: rowsHeight, measureRow, retainFocus, releaseFocus, navigateRows, measureOffset } = useGuideRows(guideRows, viewportReady);
const visibleByChannel = computed(() => {
	const result = new Map<string, Array<TimelineSegment | GuideEntry>>();
	if (!viewportReady.value || !daysGeometry.value.length) {
		return result;
	}
	const origin = daysGeometry.value[0]!.startMilliseconds;
	const millisecondsPerPixel = 3_600_000 / hourWidth.value;
	for (const { row } of visibleRows.value) {
		if (row.type !== 'channel') {
			continue;
		}
		const channelId = row.channel.id;
		const programmes: Array<TimelineSegment | GuideEntry> = displayedByChannel.value.get(channelId) ?? [];
		const visible = guideIntervalIndex(programmes).query(
			origin + viewportStart.value * millisecondsPerPixel,
			origin + viewportEnd.value * millisecondsPerPixel,
			3 * millisecondsPerPixel,
		);
		const pinned = pinnedProgramme.value;
		if (pinned && pinned.channelId === channelId && !visible.includes(pinned)) {
			visible.push(pinned);
		}
		result.set(channelId, visible);
	}
	return result;
});
let viewportFrame = 0;
let viewportObserver: ResizeObserver | null = null;

/** Read the scrolled timeline window and quantize it to hour-sized buckets. */
function readViewport(): void {
	const scroller = guideScroll.value;
	if (!scroller || trackWidth.value === 0) {
		return;
	}

	viewportReady.value = true;
	const unit = hourWidth.value;
	const overscan = unit * GUIDE_OVERSCAN_HOURS;
	const start = Math.floor((scroller.scrollLeft - overscan) / unit) * unit;
	const end = Math.ceil(
		(scroller.scrollLeft + trackWidth.value + overscan) / unit,
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
		readViewport();
	});
}

/** One formatter shared by every ruler tick. */
const hourFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' });

/** Format a wall-clock hour using the viewer's preferred hour cycle. */
function displayHour(hour: number): string {
	return hourFormatter.format(new Date(Date.UTC(2026, 0, 1, hour)));
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

/** Derive each mounted listing's presentation once per viewport or data change. */
const listingViews = computed(() => {
	const views = new Map<TimelineSegment | GuideEntry, {
		style: Record<string, string>;
		thumb: ReturnType<typeof guideListingThumb>;
		wash: string | null;
		timespan: string;
	}>();
	for (const programmes of visibleByChannel.value.values()) {
		for (const programme of programmes) {
			views.set(programme, {
				style: segmentStyle(programme), thumb: listingThumb(programme), wash: listingWash(programme),
				timespan: props.listingPresentation === 'guide'
					? guideListingTimespan(programme.start, programme.finish, props.timeZone) : '',
			});
		}
	}
	return views;
});

/** Read presentation metadata for a listing selected by the current viewport. */
function listingView(programme: TimelineSegment | GuideEntry) {
	return listingViews.value.get(programme)!;
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
			pinnedProgramme.value = entry;
			activeChannelId.value = entry.channelId;
			emit('inspect', { id: entry.id, target: event.currentTarget });
		}
		return;
	}

	pinnedProgramme.value = entry;
	activeChannelId.value = entry.channelId;
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
			? guideIntervalIndex(activeSegments.value).query(Date.parse(entry.start), Date.parse(entry.finish))
				.find(segment => segment.id === entry.segmentId) : entry;
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
	pinnedProgramme.value = null;
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
		if (previous && previous[1] !== props.guide) {
			pinnedProgramme.value = null;
		}
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
		measureOffset();
	},
);
onMounted(() => {
	measureTrack();
	scrollToCurrentTime();
	readViewport();
	guideScroll.value?.addEventListener('scroll', scheduleViewportRead, { passive: true });
	viewportObserver = new ResizeObserver(() => {
		measureTrack();
		scheduleViewportRead();
	});
	if (guideScroll.value) {
		viewportObserver.observe(guideScroll.value);
	}
});
onBeforeUnmount(() => {
	closeSegment();
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
				<div ref="rowsBody" class="guide-rows" :style="{ height: `${rowsHeight}px` }" @focusin="retainFocus" @focusout="releaseFocus" @keydown="navigateRows">
					<div v-for="{ row, index, top } in visibleRows" :key="row.key" :ref="measureRow" class="guide-row" :class="{ 'guide-row-last': index === guideRows.length - 1 }" tabindex="-1" :data-index="index" :data-guide-row="row.key" :style="{ top: `${top}px` }">
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
										:style="listingView(segment).style"
										:aria-label="`${segment.title}, ${segment.start} – ${segment.finish}`"
										@click="openEntry(segment, $event, true)"
										@pointerenter="openEntry(segment, $event)"
										@pointermove="'kind' in segment && segment.kind === 'block' && blockPopover?.move($event, segment)"
										@focusin="openEntry(segment, $event)"
										@pointerleave="leaveEntry"
										@focusout="leaveEntry"
									>
										<img
											v-if="listingView(segment).wash"
											class="guide-programme-fanart"
											:src="artworkVariantUrl(listingView(segment).wash, 'card')"
											:srcset="artworkSrcset(listingView(segment).wash, 'card')"
											alt=""
											loading="lazy"
											decoding="async"
										/>
										<img
											v-if="listingView(segment).thumb"
											class="guide-programme-thumb"
											:class="`guide-programme-thumb-${listingView(segment).thumb!.kind}`"
											:src="artworkVariantUrl(listingView(segment).thumb!.url, 'card')"
											:srcset="artworkSrcset(listingView(segment).thumb!.url, 'card')"
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
												listingView(segment).timespan
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
					</div>
				</div>
			</div>
		</div>
	</div>
	<GuideItemPreview ref="itemPreview" />
	<GuideBlockPopover ref="blockPopover" :segments="activeSegments" :program-names="programNames" :time-zone="timeZone" @select="openSegment" />
	<GuideSegmentPreviewModal
		v-if="selectedLoading || selectedDetail || selectedError"
		:detail="selectedDetail"
		:loading="selectedLoading"
		:error="selectedError"
		:time-zone="timeZone"
		@close="closeSegment"
	/>
</template>
