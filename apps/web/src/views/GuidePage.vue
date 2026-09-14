<script setup lang="ts">
import { useGuideDateRefresh } from '../composables/useGuideDateRefresh';
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { storeToRefs } from 'pinia';
import {
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	Clock3,
	Copy,
	ExternalLink,
	RadioTower,
} from '@lucide/vue';
import { XMLTV_EPG_DAYS } from '@moirai/shared';
import GuideTimeline from '../components/GuideTimeline.vue';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import ResourceEmptyState from '../components/ResourceEmptyState.vue';
import { calendarDateSpan, dateKey, formatDateKey, shiftDateKey } from '../date-key';
import { errorMessage } from '../error-message';
import { liveEvents } from '../live-events';
import { affectsGuide } from '../guide-events';
import { useChannelsStore } from '../stores/channels';

const channelsStore = useChannelsStore();
const {
	channels,
	guide,
	timeZone,
	publicUrl,
	publicUrlStatus,
	loaded: channelsLoaded,
	capabilitiesLoaded,
	guideLoaded,
	guideWeekStart: weekStart,
	guideDays,
} = storeToRefs(channelsStore);
const initialLoading = ref(
	!(channelsLoaded.value && capabilitiesLoaded.value && guideLoaded.value && guideDays.value >= 7),
);
const error = ref('');
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/** Public client URL whose copy action owns a transient status notice. */
type ClientUrlKind = 'playlist' | 'guide';
const copyNotices = reactive<Record<ClientUrlKind, { message: string; visible: boolean }>>({
	playlist: { message: '', visible: false },
	guide: { message: '', visible: false },
});
const copyNoticeTimers: Partial<Record<ClientUrlKind, ReturnType<typeof setTimeout>>> = {};

const epgUrl = computed(() =>
	publicUrl.value ? `${publicUrl.value.replace(/\/+$/, '')}/epg.xml` : '');
const m3uUrl = computed(() =>
	publicUrl.value ? `${publicUrl.value.replace(/\/+$/, '')}/iptv/channels.m3u` : '');
const displayedDays = computed(() => guide.value?.days ?? 7);
const requestedWindowDays = computed(() => {
	return requestedDaysFor(weekStart.value);
});

/** Bound one guide request to the remaining committed range from its proposed start. */
function requestedDaysFor(startDate: string): number {
	const committedEndDate = guide.value?.committedEndDate;
	if (!committedEndDate || !startDate) {
		return 7;
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

/** Load the committed seven-day guide beginning at the selected date. */
async function loadGuide(): Promise<void> {
	if (!weekStart.value) {
		return;
	}

	await channelsStore.loadGuide(weekStart.value, requestedWindowDays.value);
	error.value = '';
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
			&& guideDays.value >= 7
			&& Boolean(weekStart.value);
	if (!hasCachedPage) {
		initialLoading.value = true;
	}
	error.value = '';
	try {
		await Promise.all([channelsStore.loadChannels(), channelsStore.loadCapabilities()]);
		if (!weekStart.value || guideDays.value < requestedWindowDays.value) {
			weekStart.value = dateKey(new Date(), timeZone.value);
		}
		await loadGuide();
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
}

/** Reset the EPG view to the week containing today. */
async function showToday(): Promise<void> {
	const today = dateKey(new Date(), timeZone.value);
	await channelsStore.loadGuide(today, requestedDaysFor(today));
	channelsStore.clearGuideNavigationHistory();
}

/** Display copy feedback briefly without adding or removing layout content. */
function showCopyNotice(kind: ClientUrlKind, message: string): void {
	const currentTimer = copyNoticeTimers[kind];
	if (currentTimer) {
		clearTimeout(currentTimer);
	}

	copyNotices[kind].message = message;
	copyNotices[kind].visible = true;
	copyNoticeTimers[kind] = setTimeout(() => {
		copyNotices[kind].visible = false;
		delete copyNoticeTimers[kind];
	}, 1_800);
}

/** Copy one public IPTV client URL, with a selection fallback for older browsers. */
async function copyClientUrl(value: string, label: string, kind: ClientUrlKind): Promise<void> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(value);
		}
		else {
			const input = document.createElement('textarea');
			input.value = value;
			input.style.position = 'fixed';
			input.style.opacity = '0';
			document.body.append(input);
			input.select();
			if (!document.execCommand('copy')) {
				throw new Error('Copy command was rejected');
			}

			input.remove();
		}
		showCopyNotice(kind, `${label} copied`);
	}
	catch {
		showCopyNotice(kind, 'Unable to copy');
	}
}

/** Select a complete client URL when its read-only field receives focus. */
function selectClientUrl(event: FocusEvent): void {
	(event.currentTarget as HTMLInputElement).select();
}

/** Coalesce live scheduling and catalog changes into one guide refresh. */
function scheduleRefresh(): void {
	if (refreshTimer) {
		clearTimeout(refreshTimer);
	}
	refreshTimer = setTimeout(() => {
		refreshTimer = undefined;
		void Promise.all([channelsStore.loadChannels(), loadGuide()]).catch((cause) => {
			error.value = errorMessage(cause);
		});
	}, 180);
}

const unsubscribe = liveEvents.subscribe((event) => {
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
	for (const timer of Object.values(copyNoticeTimers)) {
		clearTimeout(timer);
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
					A committed rolling {{ XMLTV_EPG_DAYS }}-day guide generated in {{ timeZone }}. Draft
					previews never advance playback state.
				</p>
				<p v-if="publicUrlStatus === 'unreachable-default'" class="notice warning">
					This loopback URL will not work from a remote IPTV client. Configure
					<code>MOIRAI_PUBLIC_URL</code> with a reachable address.
				</p>
				<div class="epg-url-fields">
					<div class="epg-url-field">
						<label for="channel-playlist-url">Channel playlist (M3U)</label>
						<div class="epg-url-row">
							<input
								id="channel-playlist-url"
								:value="m3uUrl"
								readonly
								@focus="selectClientUrl"
							/>
							<span class="epg-copy-control">
								<button
									class="button"
									:disabled="!m3uUrl"
									@click="copyClientUrl(m3uUrl, 'Playlist URL', 'playlist')"
								>
									<Copy :size="17" />Copy URL
								</button>
								<span
									class="epg-copy-status"
									:class="{ visible: copyNotices.playlist.visible }"
									aria-live="polite"
								>{{ copyNotices.playlist.message }}</span
								>
							</span>
							<a class="button secondary" :href="m3uUrl" target="_blank" rel="noopener">
								<ExternalLink :size="17" />Open
							</a>
						</div>
					</div>
					<div class="epg-url-field">
						<label for="xmltv-epg-url">XMLTV guide</label>
						<div class="epg-url-row">
							<input
								id="xmltv-epg-url"
								:value="epgUrl"
								readonly
								@focus="selectClientUrl"
							/>
							<span class="epg-copy-control">
								<button
									class="button"
									:disabled="!epgUrl"
									@click="copyClientUrl(epgUrl, 'EPG URL', 'guide')"
								>
									<Copy :size="17" />Copy URL
								</button>
								<span
									class="epg-copy-status"
									:class="{ visible: copyNotices.guide.visible }"
									aria-live="polite"
								>{{ copyNotices.guide.message }}</span
								>
							</span>
							<a class="button secondary" :href="epgUrl" target="_blank" rel="noopener">
								<ExternalLink :size="17" />Open
							</a>
						</div>
					</div>
				</div>
			</div>
		</div>

		<p v-if="error" class="notice error">{{ error }}</p>
		<LoadingState v-if="initialLoading" label="Loading the channel guide…" />
		<div v-else class="async-state-surface">
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
			<p v-if="guide?.segmentLimitApplied" class="notice warning">
				Showing {{ guide.days }} of {{ guide.requestedDays }} requested days because this
				schedule contains an unusually high number of programs.
			</p>
			<GuideTimeline
				v-if="channels.length"
				:channels="channels"
				:guide="guide"
				:time-zone="timeZone"
				:start-date="weekStart"
				:days="displayedDays"
			/>
			<ResourceEmptyState
				v-else-if="!error"
				title="No channels configured"
				description="Create a channel before connecting an IPTV client to the guide."
			>
				<template #icon><RadioTower :size="37" /></template>
				<RouterLink class="button" to="/channels?new=1">Create Channel</RouterLink>
			</ResourceEmptyState>
		</div>
	</section>
</template>
