<script setup lang="ts">
import { useClipboardFeedback } from '../composables/useClipboardFeedback';
import TransientToast from '../components/TransientToast.vue';
import { useGuideRouteDate } from '../composables/useGuideRouteDate';
import { useGuideDateRefresh } from '../composables/useGuideDateRefresh';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import {
	Plus,
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	Clock3,
	FileCode,
	FileText,
	RadioTower,
} from '@lucide/vue';
import GuideTimeline from '../components/GuideTimeline.vue';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import ResourceEmptyState from '../components/ResourceEmptyState.vue';
import { calendarDateSpan, dateKey, formatDateKey, shiftDateKey } from '../date-key';
import { errorMessage } from '../error-message';
import { liveEvents } from '../live-events';
import { affectsGuide } from '../guide-events';
import { useChannelsStore } from '../stores/channels';

const guideTimeline = ref<InstanceType<typeof GuideTimeline>>();
const channelsStore = useChannelsStore();
const {
	channels,
	guide,
	timeZone,
	guideHorizonDays,
	publicUrl,
	publicUrlStatus,
	loaded: channelsLoaded,
	capabilitiesLoaded,
	guideLoaded,
	guideWeekStart: weekStart,
	guideDays,
} = storeToRefs(channelsStore);
const initialLoading = ref(
	!(channelsLoaded.value && capabilitiesLoaded.value && guideLoaded.value && guideDays.value >= 1),
);
const error = ref('');

/** Drop the full-page spinner as soon as a committed day is in the store. */
function dismissInitialLoadingWhenGuidePaints(): void {
	if (channelsLoaded.value && capabilitiesLoaded.value && guideLoaded.value && guideDays.value >= 1) {
		initialLoading.value = false;
	}
}

watch(
	[channelsLoaded, capabilitiesLoaded, guideLoaded, guideDays],
	() => {
		dismissInitialLoadingWhenGuidePaints();
	},
);

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

const { message: copyMessage, error: copyError, copy: copyClientUrl } = useClipboardFeedback();

const epgUrl = computed(() =>
	publicUrl.value ? `${publicUrl.value.replace(/\/+$/, '')}/epg.xml` : '');
const m3uUrl = computed(() =>
	publicUrl.value ? `${publicUrl.value.replace(/\/+$/, '')}/iptv/channels.m3u` : '');
const displayedDays = computed(() => guide.value?.days ?? 7);

/** Bound one guide request to the remaining committed range from its proposed start. */
function requestedDaysFor(startDate: string): number {
	const committedEndDate = guide.value?.committedEndDate;
	if (!committedEndDate || !startDate) {
		return Math.min(7, guideHorizonDays.value);
	}

	return Math.max(1, Math.min(7, calendarDateSpan(startDate, committedEndDate)));
}

const weekLabel = computed(() => {
	if (!weekStart.value) {
		return '';
	}

	return `${formatDateKey(weekStart.value, { month: 'short', day: 'numeric' })} – ${formatDateKey(shiftDateKey(weekStart.value, displayedDays.value - 1), { month: 'short', day: 'numeric', year: 'numeric' })}`;
});
const canMovePrevious = computed(() =>
	channelsStore.guideNavigationTarget('backward') !== null);
const canMoveNext = computed(() =>
	channelsStore.guideNavigationTarget('forward') !== null);

const guideRoute = useGuideRouteDate(channelsStore, loadGuide, cause => {
	error.value = errorMessage(cause);
});

/** Load the committed seven-day guide beginning at the selected date. */
async function loadGuide(reusePending = false): Promise<void> {
	if (!weekStart.value) {
		return;
	}

	const target = guideRoute.requestedDate();
	if (await guideRoute.load(() => channelsStore.loadGuide(target, requestedDaysFor(target), 'preserve', reusePending))) {
		error.value = '';
	}
}

useGuideDateRefresh(channelsStore, loadGuide, (cause) => {
	error.value = errorMessage(cause);
});

/** Load channel metadata and the initial committed guide without discarding cached state. */
async function loadInitial(): Promise<void> {
	const hasCachedPage
		= channelsLoaded.value
			&& capabilitiesLoaded.value
			&& guideLoaded.value
			&& guideDays.value >= 1
			&& Boolean(weekStart.value);
	if (!hasCachedPage) {
		initialLoading.value = true;
	}
	error.value = '';
	try {
		await Promise.all([channelsStore.loadChannels(), channelsStore.loadCapabilities()]);
		const today = dateKey(new Date(), timeZone.value);
		if (!weekStart.value || weekStart.value < today) {
			weekStart.value = today;
		}
		await loadGuide(true);
		guideRoute.activate();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		initialLoading.value = false;
	}
}

/** Move the guide window within the committed range and load the resulting week. */
async function moveWindow(direction: -1 | 1): Promise<void> {
	if ((direction < 0 && !canMovePrevious.value) || (direction > 0 && !canMoveNext.value)) {
		return;
	}

	const target = channelsStore.guideNavigationTarget(direction < 0 ? 'backward' : 'forward');
	if (!target) {
		return;
	}

	await channelsStore.loadGuide(
		target,
		requestedDaysFor(target),
		direction < 0 ? 'backward' : 'forward',
	);
	await guideRoute.remember();
}

/** Return to today’s guide window, or center now when it is already selected. */
async function showToday(): Promise<void> {
	const today = dateKey(new Date(), timeZone.value);
	if (weekStart.value === today) {
		guideTimeline.value?.centerCurrentTime();
		return;
	}

	await channelsStore.loadGuide(today, requestedDaysFor(today));
	channelsStore.clearGuideNavigationHistory();
	await guideRoute.remember();
}

/** Coalesce live scheduling and catalog changes into one guide refresh. */
function scheduleRefresh(): void {
	if (refreshTimer) {
		clearTimeout(refreshTimer);
	}
	refreshTimer = setTimeout(() => {
		refreshTimer = undefined;
		void Promise.all([channelsStore.loadChannels(true), loadGuide()]).catch((cause) => {
			error.value = errorMessage(cause);
		});
	}, 180);
}

const unsubscribe = liveEvents.subscribe((event) => {
	if (event.type === 'system.ready') {
		channelsStore.invalidateCapabilities();
	}

	if (affectsGuide(event)) {
		scheduleRefresh();
	}
});

onMounted(() => void loadInitial());
onBeforeUnmount(() => {
	unsubscribe();
	if (refreshTimer) {
		clearTimeout(refreshTimer);
	}

});
</script>

<template>
	<section class="epg-page">
		<PageHeader
			eyebrow="Electronic program guide"
			title="Guide"
			description="Review the resolved channel lineup and connect IPTV clients to Moirai."
		/>

		<div class="epg-feed-card">
			<span class="epg-feed-icon"><RadioTower :size="25" /></span>
			<div class="epg-feed-copy">
				<p class="eyebrow">IPTV client feed</p>
				<h2>Playlist and guide URLs</h2>
				<p>
					A committed rolling {{ guideHorizonDays }}-day guide generated in {{ timeZone }}. Draft
					previews never advance playback state.
				</p>
				<p v-if="publicUrlStatus === 'unreachable-default'" class="notice warning">
					This loopback URL will not work from a remote IPTV client. Configure
					<code>MOIRAI_PUBLIC_URL</code> with a reachable address.
				</p>
			</div>
			<div class="epg-feed-actions">
				<button type="button" class="button secondary" :disabled="!m3uUrl" aria-label="Copy M3U playlist URL" @click="copyClientUrl(m3uUrl, 'Playlist URL')"><FileText :size="18" aria-hidden="true" />M3U</button>
				<button type="button" class="button secondary" :disabled="!epgUrl" aria-label="Copy XMLTV guide URL" @click="copyClientUrl(epgUrl, 'EPG URL')"><FileCode :size="18" aria-hidden="true" />XMLTV</button>
			</div>
		</div>

		<p v-if="error" class="notice error">{{ error }} <button v-if="channelsStore.guideError" class="button secondary" type="button" @click="loadGuide()">Retry guide</button></p>
		<LoadingState v-if="initialLoading" label="Loading the channel guide…" />
		<div v-else class="async-state-surface">
			<p v-if="guide?.segmentLimitApplied" class="notice warning">
				Showing {{ guide.days }} of {{ guide.requestedDays }} requested days because this
				schedule contains an unusually high number of programs.
			</p>
			<GuideTimeline
				v-if="channels.length"
				ref="guideTimeline"
				:channels="channels"
				:guide="guide"
				:refreshing="channelsStore.guideRefreshing"
				:row-states="channelsStore.guideRowStates"
				:time-zone="timeZone"
				:start-date="weekStart"
				:days="displayedDays"
				use-entry-titles
				subtitle-mode="listing"
				listing-presentation="guide"
				@retry="loadGuide()"
			>
				<template #toolbar>
					<div class="guide-toolbar">
						<div class="guide-week-controls">
							<button
								class="square-button"
								aria-label="Previous week"
								:disabled="!canMovePrevious"
								@click="moveWindow(-1)"
							>
								<ChevronLeft :size="18" />
							</button>
							<button class="toolbar-button" @click="showToday">
								<CalendarDays :size="17" />Today
							</button>
							<button
								class="square-button"
								aria-label="Next week"
								:disabled="!canMoveNext"
								@click="moveWindow(1)"
							>
								<ChevronRight :size="18" />
							</button>
							<strong>{{ weekLabel }}</strong>
						</div>
						<span class="guide-time-zone"><Clock3 :size="15" />{{ timeZone }}</span>
					</div>
				</template>
			</GuideTimeline>
			<ResourceEmptyState
				v-else-if="!error"
				title="No channels configured"
				description="Create a channel before connecting an IPTV client to the guide."
			>
				<template #icon><RadioTower :size="37" /></template>
				<RouterLink class="button" to="/channels?new=1"><Plus :size="18" aria-hidden="true" />Create Channel</RouterLink>
			</ResourceEmptyState>
		</div>
		<div v-if="copyError" class="notice error epg-copy-error" role="alert"><p>{{ copyError }}</p><span>M3U <code>{{ m3uUrl }}</code></span><span>XMLTV <code>{{ epgUrl }}</code></span><button type="button" class="button secondary" @click="copyError = ''">Dismiss</button></div>
		<TransientToast v-if="copyMessage" :message="copyMessage" @close="copyMessage = ''" />
	</section>
</template>
