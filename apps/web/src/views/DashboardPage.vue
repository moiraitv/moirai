<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { AlertTriangle, ArrowRight, CheckCircle2, Library, RadioTower, RefreshCw, TvMinimal } from '@lucide/vue';
import type { DataConflict, Library as LibraryRecord } from '@moirai/shared';
import { api } from '../api';
import { channelLogoUrl } from '../channel-logo';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import PlaybackNowPlaying from '../components/PlaybackNowPlaying.vue';
import StatusPill from '../components/StatusPill.vue';
import { useChannelsStore } from '../stores/channels';
import { useDashboardStore } from '../stores/dashboard';
import { useLibrariesStore } from '../stores/libraries';
import { liveEvents } from '../live-events';
import { errorMessage } from '../error-message';
import { hideBrokenImage } from '../image-error';
import { countLabel } from '../count-label';
import {
	playbackAccelerationLabel,
	playbackClientDurationLabel,
} from '../playback-session-format';

const librariesStore = useLibrariesStore();
const { libraries, loading, loaded, error: libraryError } = storeToRefs(librariesStore);
const channelsStore = useChannelsStore();
const {
	channels,
	loading: channelsLoading,
	loaded: channelsLoaded,
	error: channelError,
} = storeToRefs(channelsStore);
const dashboardStore = useDashboardStore();
const {
	playback,
	conflictReport,
	loading: summaryLoading,
	loaded: summaryLoaded,
	error,
} = storeToRefs(dashboardStore);
const displayNowMs = ref(Date.now());
let unsubscribe: (() => void) | null = null;
let statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
let positionClockTimer: ReturnType<typeof setInterval> | undefined;
let programmingBoundaryTimer: ReturnType<typeof setTimeout> | undefined;
/** Polling interval that recovers authoritative playback state after missed live events. */
const STATUS_REFRESH_INTERVAL_MS = 15_000;
/** Local display interval for smooth program positions and client durations. */
const POSITION_CLOCK_INTERVAL_MS = 1_000;
const mediaCount = computed(() =>
	libraries.value.reduce((total, library) => total + library.itemCount, 0));
const channelsById = computed(() => new Map(channels.value.map((channel) => [channel.id, channel])));

/** Format active playback capacity with a noun matching the active count. */
function playbackCapacity(): string {
	if (!playback.value) {
		return 'Loading playback engine';
	}

	const noun = playback.value.activeSessionCount === 1 ? 'channel' : 'channels';
	return `${playback.value.activeSessionCount}/${playback.value.maxActiveSessions} ${noun} active`;
}
/** Return whether any configured library currently has an active scan. */
function isScanning(library: LibraryRecord): boolean {
	return Boolean(
		library.lastScanStartedAt
		&& (!library.lastScanCompletedAt || library.lastScanStartedAt > library.lastScanCompletedAt),
	);
}

/** Return the editor or library destination relevant to a conflict. */
function conflictLink(conflict: DataConflict): string {
	if (conflict.resourceType === 'library' && conflict.resourceId) {
		return `/libraries/${conflict.resourceId}`;
	}

	if (conflict.resourceType === 'program') {
		return conflict.resourceId ? `/schedules/programs/${encodeURIComponent(conflict.resourceId)}` : '/schedules/programs';
	}

	if (conflict.resourceType === 'template') {
		return conflict.resourceId ? `/schedules/templates/${encodeURIComponent(conflict.resourceId)}` : '/schedules/templates';
	}

	return '/channels';
}

/** Resolve a session's configured channel logo from the loaded channel catalog. */
function sessionChannelLogo(channelId: string): string | null {
	const channel = channelsById.value.get(channelId);
	return channel ? channelLogoUrl(channel) : null;
}

/** Restart a channel worker and refresh the session list. */
async function restart(channelId: string): Promise<void> {
	try {
		await api.restartPlaybackChannel(channelId);
		await dashboardStore.refreshPlayback();
	}
	catch (cause) {
		dashboardStore.error = errorMessage(cause);
	}
}

/** Refresh playback just after the earliest displayed program reaches its committed finish. */
function scheduleProgrammingBoundaryRefresh(): void {
	clearTimeout(programmingBoundaryTimer);
	programmingBoundaryTimer = undefined;
	const nowMs = Date.now();
	const nextFinishMs = Math.min(
		...(playback.value?.sessions ?? [])
			.map((session) => session.nowPlaying ? Date.parse(session.nowPlaying.finishesAt) : NaN)
			.filter((finishMs) => Number.isFinite(finishMs) && finishMs > nowMs),
	);
	if (!Number.isFinite(nextFinishMs)) {
		return;
	}

	programmingBoundaryTimer = setTimeout(
		() => void dashboardStore.refreshPlayback(),
		Math.max(250, nextFinishMs - nowMs + 250),
	);
}

watch(playback, scheduleProgrammingBoundaryRefresh);

onMounted(() => {
	void librariesStore.load();
	void channelsStore.loadChannels();
	void dashboardStore.load();
	unsubscribe = liveEvents.subscribe((event) => {
		if (
			event.type === 'system.ready'
			|| event.type === 'library.changed'
			|| event.type === 'channel.changed'
			|| event.type === 'scheduling.changed'
			|| (event.type === 'scan.changed' && event.data.status !== 'running')
		) {
			void dashboardStore.load();
		}
		else if (event.type === 'playback.changed') {
			void dashboardStore.refreshPlayback();
		}
		if (event.type === 'channel.changed') {
			void channelsStore.loadChannels().catch(() => undefined);
		}
	});
	statusRefreshTimer = setInterval(
		() => void dashboardStore.refreshPlayback(),
		STATUS_REFRESH_INTERVAL_MS,
	);
	positionClockTimer = setInterval(() => {
		displayNowMs.value = Date.now();
	}, POSITION_CLOCK_INTERVAL_MS);
});
onUnmounted(() => {
	unsubscribe?.();
	clearTimeout(programmingBoundaryTimer);
	if (statusRefreshTimer) {
		clearInterval(statusRefreshTimer);
	}
	if (positionClockTimer) {
		clearInterval(positionClockTimer);
	}
});
</script>
<template>
	<section>
		<PageHeader
			eyebrow="System status"
			title="Status"
			description="Monitor the media index, channel configuration, and integrated IPTV service."
		/>
		<p v-if="error || libraryError || channelError" class="notice error">
			{{ error || libraryError || channelError }}
		</p>
		<LoadingState
			v-if="
				(loading && !loaded) ||
					(channelsLoading && !channelsLoaded) ||
					(summaryLoading && !summaryLoaded)
			"
			label="Loading overview…"
		/>
		<template v-else-if="loaded && channelsLoaded && summaryLoaded">
			<div class="section-heading status-session-heading">
				<div>
					<p class="eyebrow">On demand</p>
					<h2>Active channels</h2>
				</div>
			</div>
			<div v-if="playback?.sessions.length" class="list-panel status-session-list">
				<div
					v-for="session in playback.sessions"
					:key="session.channelId"
					class="list-row playback-session-row"
				>
					<div class="playback-session-controls">
						<span class="media-glyph playback-session-glyph">
							<RadioTower :size="18" />
							<img
								v-if="sessionChannelLogo(session.channelId)"
								class="playback-session-logo"
								:src="sessionChannelLogo(session.channelId) ?? undefined"
								alt=""
								@error="hideBrokenImage"
							/>
						</span>
						<button
							class="icon-button playback-session-restart"
							aria-label="Restart channel playback"
							title="Restart channel playback"
							@click="restart(session.channelId)"
						>
							<RefreshCw :size="14" />
						</button>
					</div>
					<div class="grow playback-session-details">
						<div class="playback-session-heading">
							<strong>{{ session.channelNumber }} • {{ session.channelName }}</strong>
							<span>Started {{ new Date(session.startedAt).toLocaleString() }}</span>
						</div>
						<small v-if="session.lastError" class="playback-session-error">
							{{ session.lastError }}
						</small>
						<div class="playback-session-activity">
							<PlaybackNowPlaying :item="session.nowPlaying" :now-ms="displayNowMs" />
							<section class="playback-client-panel">
								<p class="eyebrow playback-activity-heading">Clients</p>
								<div class="playback-client-list">
									<small
										v-for="client in session.clients"
										:key="`${client.address}\u0000${client.userAgent ?? ''}`"
										class="playback-client"
									>
										<span class="playback-client-address">{{ client.address }}</span>
										<span>Watching {{ playbackClientDurationLabel(client.firstSeenAt, displayNowMs) }}</span>
										<span class="playback-client-agent" :title="client.userAgent ?? undefined">
											{{ client.userAgent ?? 'User-Agent unavailable' }}
										</span>
									</small>
									<small v-if="!session.clients.length" class="playback-client empty">
										No active client request observed
									</small>
								</div>
							</section>
						</div>
					</div>
					<div class="playback-session-side">
						<StatusPill :value="session.state === 'ready' ? 'playing' : session.state" />
						<small class="playback-acceleration">
							<span>Acceleration</span>{{ playbackAccelerationLabel(session.acceleration) }}
						</small>
					</div>
				</div>
			</div>
			<div v-else class="empty-state playback-empty-state">
				<RadioTower :size="22" />
				<div>
					<h3>No active channels</h3>
					<p>A channel worker starts when an IPTV client tunes to that channel.</p>
				</div>
			</div>
			<div class="metric-grid">
				<article class="metric">
					<span class="metric-icon green"><Library :size="20" /></span><span>Libraries</span
					><strong>{{ libraries.length }}</strong
					><small>{{ countLabel(mediaCount, 'indexed item') }}</small>
				</article>
				<article class="metric">
					<span class="metric-icon blue"><TvMinimal :size="20" /></span><span>Channels</span
					><strong>{{ channels.length }}</strong
					><small>Configured for playout</small>
				</article>
				<article class="metric">
					<span class="metric-icon purple"><RadioTower :size="20" /></span
					><span>IPTV service</span
					><strong class="metric-status">{{ playback?.status ?? 'Checking' }}</strong
					><small class="playback-capacity">{{ playbackCapacity() }}</small>
				</article>
			</div>
			<div class="section-heading">
				<div>
					<p class="eyebrow">Live index</p>
					<h2>Library health</h2>
				</div>
				<RouterLink class="button secondary" to="/libraries"
				>Manage Libraries<ArrowRight :size="17"
				/></RouterLink>
			</div>
			<div v-if="libraries.length" class="list-panel">
				<RouterLink
					v-for="library in libraries"
					:key="library.id"
					:to="`/libraries/${library.id}`"
					class="list-row"
				>
					<span class="media-glyph"><Library :size="18" /></span>
					<span class="grow"
					><strong>{{ library.name }}</strong
					><small>{{ library.typeKey }} · {{ countLabel(library.itemCount, 'item') }}</small></span
					>
					<StatusPill :value="isScanning(library) ? 'running' : library.watcherStatus" />
				</RouterLink>
			</div>
			<div v-else class="empty-state">
				<Library :size="48" />
				<h3>No libraries yet</h3>
				<p>Add a media folder to begin building the index.</p>
				<div class="form-actions">
					<RouterLink class="button" to="/quick">Quick Setup</RouterLink>
					<RouterLink class="button secondary" to="/libraries">Manage Libraries</RouterLink>
				</div>
			</div>
			<div class="section-heading">
				<div>
					<p class="eyebrow">Data quality</p>
					<h2>Data conflicts</h2>
				</div>
			</div>
			<div v-if="conflictReport?.conflicts.length" class="list-panel">
				<RouterLink
					v-for="conflict in conflictReport.conflicts"
					:key="conflict.id"
					:to="conflictLink(conflict)"
					class="list-row"
				>
					<span class="media-glyph"><AlertTriangle :size="18" /></span>
					<span class="grow">
						<strong>{{ conflict.title }}</strong>
						<small>{{ conflict.message }}</small>
						<small v-if="conflict.paths.length">{{ conflict.paths.join(' · ') }}</small>
					</span>
					<StatusPill :value="conflict.severity" />
				</RouterLink>
			</div>
			<div v-else class="empty-state compact">
				<CheckCircle2 :size="28" />
				<h3>No data conflicts</h3>
				<p>Catalog and user-defined identities are currently unambiguous.</p>
			</div>
			<p v-if="conflictReport?.truncated" class="notice">
				Only the first 100 conflicts are shown.
			</p>
		</template>
	</section>
</template>
