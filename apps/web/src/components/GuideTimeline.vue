<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { TvMinimal } from '@lucide/vue';
import type { Channel, GuideSegmentDetail, ScheduleGuide, TimelineSegment } from '@moirai/shared';
import { api } from '../api';
import { channelLogoUrl } from '../channel-logo';
import { dateKey, formatDateKey, shiftDateKey } from '../date-key';
import { errorMessage } from '../error-message';
import { guideSegmentWidth } from '../guide-geometry';
import { channelGuideRows } from '../channel-groups';
import { programColorStyle } from '../program-colors';
import GuideSegmentPreviewModal from './GuideSegmentPreviewModal.vue';

const props = withDefaults(
	defineProps<{
		channels: Channel[];
		guide: ScheduleGuide | null;
		timeZone: string;
		startDate: string;
		days?: number;
		emptyMessage?: string;
	}>(),
	{ days: 7, emptyMessage: 'No schedule assigned' },
);

defineSlots<{
	detail(props: {
		channel: Channel;
		preview: ScheduleGuide['channels'][number]['preview'] | undefined;
	}): unknown;
	actions(props: { channel: Channel }): unknown;
}>();

const guideScroll = ref<HTMLElement>();
const selectedDetail = ref<GuideSegmentDetail | null>(null);
const selectedLoading = ref(false);
const selectedError = ref('');
const detailCache = new Map<string, GuideSegmentDetail>();
let detailRequest = 0;
const HOUR_WIDTH = 56;
const DAY_WIDTH = HOUR_WIDTH * 24;
const hourTicks = Array.from({ length: 12 }, (_, index) => index * 2);
const timelineWidth = computed(() => DAY_WIDTH * props.days);
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
		? Array.from({ length: props.days }, (_, index) => {
			const key = shiftDateKey(props.startDate, index);
			return {
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

	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: props.timeZone,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(now);
	const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((entry) => entry.type === type)?.value ?? 0);
	const fractionalHour
		= numberPart('hour') + numberPart('minute') / 60 + numberPart('second') / 3_600;
	return dayIndex * DAY_WIDTH + fractionalHour * HOUR_WIDTH;
});

/** Convert an instant to its horizontal guide position for one day. */
function localTimelinePosition(value: string): number {
	const date = new Date(value);
	const key = dateKey(date, props.timeZone);
	const dayIndex = visibleDays.value.findIndex((day) => day.key === key);
	if (dayIndex < 0) {
		return key < props.startDate ? 0 : timelineWidth.value;
	}

	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: props.timeZone,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(date);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((entry) => entry.type === type)?.value ?? 0);
	return (
		dayIndex * DAY_WIDTH
		+ (part('hour') + part('minute') / 60 + part('second') / 3_600) * HOUR_WIDTH
	);
}

/** Position and color a guide segment from its absolute playback interval and program identity. */
function segmentStyle(segment: TimelineSegment): Record<string, string> {
	return {
		left: `${localTimelinePosition(segment.start)}px`,
		width: `${guideSegmentWidth(segment.start, segment.finish, HOUR_WIDTH)}px`,
		...programColorStyle(segment.programId),
	};
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
					'--guide-day-width': `${DAY_WIDTH}px`,
					'--guide-timeline-width': `${timelineWidth}px`,
				}"
			>
				<div class="guide-corner"><TvMinimal :size="18" />Channels</div>
				<div class="guide-time-header">
					<div
						v-for="(day, dayIndex) in visibleDays"
						:key="day.key"
						class="guide-day-heading"
						:class="{ today: day.key === dateKey(new Date(), timeZone) }"
						:style="{ left: `${dayIndex * DAY_WIDTH}px`, width: `${DAY_WIDTH}px` }"
					>
						<strong>{{ day.weekday }}</strong
						><span>{{ day.date }}</span>
						<small
							v-for="hour in hourTicks"
							:key="hour"
							:style="{ left: `${hour * HOUR_WIDTH}px` }"
						>{{ displayHour(hour) }}</small
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
								<img
									v-if="channelLogoUrl(channel)"
									class="guide-channel-logo"
									:src="channelLogoUrl(channel) ?? undefined"
									alt=""
								/>
								<span v-else class="channel-number">{{ channel.number }}</span>
								<div class="guide-channel-copy">
									<h2>{{ channel.name }}</h2>
									<p>
										{{ channel.video.width }}×{{ channel.video.height }}
										{{ channel.video.format?.toUpperCase() }} ·
										{{ channel.audio.format?.toUpperCase() }}
									</p>
									<slot name="detail" :channel="channel" :preview="guideByChannel.get(channel.id)">
										<small
											v-if="guideByChannel.get(channel.id)?.issues.length"
											class="guide-warning"
										>
											{{ guideByChannel.get(channel.id)?.issues.length }} schedule warnings
										</small>
									</slot>
								</div>
								<div v-if="$slots.actions" class="guide-channel-actions">
									<slot name="actions" :channel="channel"></slot>
								</div>
							</article>
							<div class="guide-channel-track">
								<button
									v-for="segment in guideByChannel.get(channel.id)?.segments ?? []"
									:key="segment.id"
									type="button"
									class="guide-programme"
									:class="[`role-${segment.role}`, { truncated: segment.truncated }]"
									:style="segmentStyle(segment)"
									:title="`${segment.title}\n${segment.start} – ${segment.finish}`"
									@click="openSegment(segment)"
								>
									<strong>{{
										segment.role === 'dead-air' ? 'No programming' : segment.title
									}}</strong>
									<small
									>{{ segment.role
									}}<template v-if="segment.truncated"> · truncated</template></small
									>
								</button>
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
		<p class="guide-empty-note">
			Previewed from Moirai scheduling rules. Playback cursor state is not advanced by this guide.
		</p>
	</div>
	<GuideSegmentPreviewModal
		v-if="selectedLoading || selectedDetail || selectedError"
		:detail="selectedDetail"
		:loading="selectedLoading"
		:error="selectedError"
		:time-zone="timeZone"
		@close="closeSegment"
	/>
</template>
