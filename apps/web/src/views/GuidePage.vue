<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
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
import { dateKey, formatDateKey, shiftDateKey } from '../date-key';
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
const copyStatus = ref('');
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

const epgUrl = computed(() =>
	publicUrl.value ? `${publicUrl.value.replace(/\/+$/, '')}/epg.xml` : '');

const weekLabel = computed(() => {
	if (!weekStart.value) {
		return '';
	}

	return `${formatDateKey(weekStart.value, { month: 'short', day: 'numeric' })} – ${formatDateKey(shiftDateKey(weekStart.value, 6), { month: 'short', day: 'numeric', year: 'numeric' })}`;
});
const canMovePrevious = computed(() =>
	Boolean(guide.value?.committedStartDate && weekStart.value > guide.value.committedStartDate));
const canMoveNext = computed(() =>
	Boolean(
		guide.value?.committedEndDate
		&& shiftDateKey(weekStart.value, 7) < guide.value.committedEndDate,
	));

/** Load the committed seven-day guide beginning at the selected date. */
async function loadGuide(): Promise<void> {
	if (!weekStart.value) {
		return;
	}

	await channelsStore.loadGuide(weekStart.value, 7);
}

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
		if (!weekStart.value || guideDays.value < 7) {
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
async function moveWeek(days: number): Promise<void> {
	if ((days < 0 && !canMovePrevious.value) || (days > 0 && !canMoveNext.value)) {
		return;
	}

	weekStart.value = shiftDateKey(weekStart.value, days);
	await loadGuide();
}

/** Reset the EPG view to the week containing today. */
async function showToday(): Promise<void> {
	weekStart.value = dateKey(new Date(), timeZone.value);
	await loadGuide();
}

/** Copy the public XMLTV URL, with a selection fallback for older browsers. */
async function copyEpgUrl(): Promise<void> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(epgUrl.value);
		}
		else {
			const input = document.createElement('textarea');
			input.value = epgUrl.value;
			input.style.position = 'fixed';
			input.style.opacity = '0';
			document.body.append(input);
			input.select();
			if (!document.execCommand('copy')) {
				throw new Error('Copy command was rejected');
			}

			input.remove();
		}
		copyStatus.value = 'EPG URL copied';
	}
	catch {
		copyStatus.value = 'Unable to copy automatically; select the URL and copy it manually.';
	}
}

/** Select the complete XMLTV URL when its read-only field receives focus. */
function selectEpgUrl(event: FocusEvent): void {
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
});
</script>

<template>
	<section class="epg-page">
		<PageHeader
			eyebrow="Electronic program guide"
			title="Guide"
			description="Review the resolved channel lineup and connect IPTV clients to Moirai's XMLTV feed."
		/>

		<div class="epg-feed-card">
			<span class="epg-feed-icon"><RadioTower :size="25" /></span>
			<div class="epg-feed-copy">
				<p class="eyebrow">IPTV client feed</p>
				<h2>XMLTV EPG URL</h2>
				<p>
					A committed rolling {{ XMLTV_EPG_DAYS }}-day guide generated in {{ timeZone }}. Draft
					previews never advance playback state.
				</p>
				<p v-if="publicUrlStatus === 'unreachable-default'" class="notice warning">
					This loopback URL will not work from a remote IPTV client. Configure
					<code>MOIRAI_PUBLIC_URL</code> with a reachable address.
				</p>
				<div class="epg-url-row">
					<input :value="epgUrl" readonly aria-label="XMLTV EPG URL" @focus="selectEpgUrl" />
					<button class="button" :disabled="!epgUrl" @click="copyEpgUrl">
						<Copy :size="17" />Copy URL
					</button>
					<a class="button secondary" :href="epgUrl" target="_blank" rel="noopener">
						<ExternalLink :size="17" />Open
					</a>
				</div>
				<p class="epg-copy-status" aria-live="polite">{{ copyStatus }}</p>
			</div>
		</div>

		<p v-if="error" class="notice error">{{ error }}</p>
		<LoadingState v-if="initialLoading" label="Loading the channel guide…" />
		<template v-else>
			<div class="guide-toolbar">
				<div class="guide-week-controls">
					<button
						class="square-button"
						aria-label="Previous week"
						:disabled="!canMovePrevious"
						@click="moveWeek(-7)"
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
						@click="moveWeek(7)"
					>
						<ChevronRight :size="18" />
					</button>
					<strong>{{ weekLabel }}</strong>
				</div>
				<span class="guide-time-zone"><Clock3 :size="15" />{{ timeZone }}</span>
			</div>
			<GuideTimeline
				v-if="channels.length"
				:channels="channels"
				:guide="guide"
				:time-zone="timeZone"
				:start-date="weekStart"
				:days="7"
			/>
			<div v-else-if="!error" class="empty-state">
				<RadioTower :size="28" />
				<h3>No channels configured</h3>
				<p>Create a channel before connecting an IPTV client to the guide.</p>
			</div>
		</template>
	</section>
</template>
