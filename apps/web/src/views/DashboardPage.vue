<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { AlertTriangle, ArrowRight, CheckCircle2, Library, RadioTower, TvMinimal } from '@lucide/vue';
import type { DataConflict, Library as LibraryRecord } from '@moirai/shared';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import StatusPill from '../components/StatusPill.vue';
import { useChannelsStore } from '../stores/channels';
import { useDashboardStore } from '../stores/dashboard';
import { useLibrariesStore } from '../stores/libraries';
import { liveEvents } from '../live-events';

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
let unsubscribe: (() => void) | null = null;
const mediaCount = computed(() =>
	libraries.value.reduce((total, library) => total + library.itemCount, 0));
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
		return '/scheduling/programs';
	}

	if (conflict.resourceType === 'template') {
		return '/scheduling/templates';
	}

	return '/channels';
}
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
			|| event.type === 'playback.changed'
			|| (event.type === 'scan.changed' && event.data.status !== 'running')
		) {
			void dashboardStore.load();
		}
	});
});
onUnmounted(() => unsubscribe?.());
</script>
<template>
	<section>
		<PageHeader
			eyebrow="System status"
			title="Moirai overview"
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
			<div class="metric-grid">
				<article class="metric">
					<span class="metric-icon green"><Library :size="20" /></span><span>Libraries</span
					><strong>{{ libraries.length }}</strong
					><small>{{ mediaCount.toLocaleString() }} indexed items</small>
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
					><small>{{ playback ? `${playback.activeSessionCount} of ${playback.maxActiveSessions} streams active` : 'Loading playback engine' }}</small>
				</article>
			</div>
			<div class="section-heading">
				<div>
					<p class="eyebrow">Live index</p>
					<h2>Library health</h2>
				</div>
				<RouterLink class="button secondary" to="/libraries"
				>Manage libraries<ArrowRight :size="17"
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
					><small>{{ library.typeKey }} · {{ library.itemCount }} items</small></span
					>
					<StatusPill :value="isScanning(library) ? 'running' : library.watcherStatus" />
				</RouterLink>
			</div>
			<div v-else class="empty-state">
				<span>◇</span>
				<h3>No libraries yet</h3>
				<p>Add a media folder to begin building the index.</p>
				<RouterLink class="button" to="/libraries">Add library</RouterLink>
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
