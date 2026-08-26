<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { Copy, RadioTower, RefreshCw, Save } from '@lucide/vue';
import type { PlaybackEngineStatus, PlaybackSettings } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import StatusPill from '../components/StatusPill.vue';
import { liveEvents } from '../live-events';

const settings = reactive<PlaybackSettings>({ maxActiveSessions: 4 });
const status = ref<PlaybackEngineStatus | null>(null);
const initialLoading = ref(true);
const saving = ref(false);
const message = ref('');
const error = ref('');

/** Load playback settings and live engine state. */
async function load(): Promise<void> {
	try {
		const [loadedSettings, loadedStatus] = await Promise.all([
			api.playbackSettings(),
			api.playbackStatus(),
		]);
		Object.assign(settings, loadedSettings);
		status.value = loadedStatus;
		error.value = '';
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		initialLoading.value = false;
	}
}

/** Refresh engine state without replacing an edited capacity value. */
async function refreshStatus(): Promise<void> {
	try {
		status.value = await api.playbackStatus();
		error.value = '';
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

/** Persist the concurrent-session limit. */
async function save(): Promise<void> {
	saving.value = true;
	message.value = '';
	error.value = '';
	try {
		Object.assign(settings, await api.savePlaybackSettings({ ...settings }));
		message.value = 'Playback settings saved.';
		await refreshStatus();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		saving.value = false;
	}
}

/** Copy a client URL to the clipboard. */
async function copyUrl(value: string, label: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(value);
		message.value = `${label} copied.`;
	}
	catch {
		error.value = `Unable to copy ${label.toLowerCase()}.`;
	}
}

/** Explicitly restart one active or stale channel worker. */
async function restart(channelId: string): Promise<void> {
	try {
		error.value = '';
		await api.restartPlaybackChannel(channelId);
		message.value = 'Channel playback restarted.';
		await refreshStatus();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

const unsubscribe = liveEvents.subscribe((event) => {
	if (event.type === 'system.ready' || event.type === 'playback.changed') {
		void refreshStatus();
	}
});

onMounted(() => void load());
onUnmounted(() => unsubscribe());
</script>

<template>
	<section>
		<PageHeader
			eyebrow="Integrated playback"
			title="IPTV service"
			description="Moirai serves the channel playlist, guide, and live streams directly."
		>
			<button class="button secondary" :disabled="initialLoading" @click="refreshStatus">
				<RefreshCw :size="17" />Refresh status
			</button>
		</PageHeader>
		<p v-if="message" class="notice success">{{ message }}</p>
		<p v-if="error" class="notice error">{{ error }}</p>
		<LoadingState v-if="initialLoading" label="Loading playback settings…" />
		<div v-else class="settings-layout">
			<form class="panel form-grid" @submit.prevent="save">
				<div class="span-2">
					<p class="eyebrow">Client setup</p>
					<h2>Playlist and guide</h2>
					<p>Add these URLs to an IPTV client that can reach this Moirai server.</p>
				</div>
				<label class="span-2">
					<span>Channel playlist</span>
					<span class="input-with-action">
						<input :value="status?.m3uUrl ?? ''" readonly />
						<button type="button" class="icon-button" aria-label="Copy channel playlist URL" @click="copyUrl(status?.m3uUrl ?? '', 'Playlist URL')">
							<Copy :size="17" />
						</button>
					</span>
				</label>
				<label class="span-2">
					<span>XMLTV guide</span>
					<span class="input-with-action">
						<input :value="status?.epgUrl ?? ''" readonly />
						<button type="button" class="icon-button" aria-label="Copy XMLTV guide URL" @click="copyUrl(status?.epgUrl ?? '', 'Guide URL')">
							<Copy :size="17" />
						</button>
					</span>
				</label>
				<label class="span-2">
					<span>Maximum active channel sessions</span>
					<input v-model.number="settings.maxActiveSessions" type="number" min="1" max="32" />
					<small>Additional tune requests receive a retryable capacity response. Default: 4.</small>
				</label>
				<div class="form-actions span-2">
					<button class="button" :disabled="saving"><Save :size="17" />Save settings</button>
				</div>
			</form>
			<aside class="panel playback-card">
				<p class="eyebrow">Playback engine</p>
				<StatusPill :value="status?.status ?? 'degraded'" />
				<h2>{{ status?.activeSessionCount ?? 0 }} / {{ status?.maxActiveSessions ?? settings.maxActiveSessions }} active</h2>
				<p v-if="status?.engineVersion">{{ status.engineVersion }}</p>
				<p v-if="status?.detail" class="notice warning">{{ status.detail }}</p>
				<code>{{ status?.contractRevision.slice(0, 12) }}</code>
			</aside>
		</div>

		<div v-if="!initialLoading" class="section-heading">
			<div>
				<p class="eyebrow">On demand</p>
				<h2>Channel sessions</h2>
			</div>
		</div>
		<div v-if="status?.sessions.length" class="list-panel">
			<div v-for="session in status.sessions" :key="session.channelId" class="list-row">
				<span class="media-glyph"><RadioTower :size="18" /></span>
				<span class="grow">
					<strong>{{ session.channelNumber }} · {{ session.channelName }}</strong>
					<small>Started {{ new Date(session.startedAt).toLocaleString() }}<template v-if="session.lastError"> · {{ session.lastError }}</template></small>
				</span>
				<StatusPill :value="session.state" />
				<button class="button secondary" @click="restart(session.channelId)">
					<RefreshCw :size="16" />Restart
				</button>
			</div>
		</div>
		<div v-else-if="!initialLoading" class="empty-state compact">
			<RadioTower :size="28" />
			<h3>No active streams</h3>
			<p>A channel worker starts when an IPTV client tunes to that channel.</p>
		</div>
	</section>
</template>
