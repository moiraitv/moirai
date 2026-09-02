<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { Copy, RefreshCw, Save, Trash2 } from '@lucide/vue';
import type {
	PlaybackEngineStatus,
	PlaybackSettings,
	ViewingPreferenceSummary,
} from '@moirai/shared';
import { api } from '../api';
import { requestConfirmation } from '../confirmation';
import { errorMessage } from '../error-message';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import StatusPill from '../components/StatusPill.vue';
import TransientToast from '../components/TransientToast.vue';
import { liveEvents } from '../live-events';

const settings = reactive<PlaybackSettings>({
	maxActiveSessions: 4,
	viewingPreferencesEnabled: true,
});
const savedSettings = ref<PlaybackSettings | null>(null);
const status = ref<PlaybackEngineStatus | null>(null);
const initialLoading = ref(true);
const savingSection = ref<'playback' | 'viewing-preferences' | null>(null);
const message = ref('');
const error = ref('');
const preferences = ref<ViewingPreferenceSummary[]>([]);
const preferencesLoading = ref(true);
const preferencesError = ref('');
const clearingPreferences = ref(false);
const playbackSettingsDirty = computed(() => savedSettings.value !== null
	&& settings.maxActiveSessions !== savedSettings.value.maxActiveSessions);
const playbackSettingsValid = computed(() => Number.isInteger(settings.maxActiveSessions)
	&& settings.maxActiveSessions >= 1
	&& settings.maxActiveSessions <= 32);
const viewingPreferenceSettingsDirty = computed(() => savedSettings.value !== null
	&& settings.viewingPreferencesEnabled !== savedSettings.value.viewingPreferencesEnabled);
let refreshingStatus = false;
let statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
/** Polling interval that keeps client activity current without following every segment request. */
const STATUS_REFRESH_INTERVAL_MS = 15_000;

/** Load playback settings and live engine state. */
async function load(): Promise<void> {
	const preferenceLoad = api.viewingPreferences()
		.then((loadedPreferences) => {
			preferences.value = loadedPreferences;
			preferencesError.value = '';
		})
		.catch((cause) => {
			preferencesError.value = errorMessage(cause);
		})
		.finally(() => {
			preferencesLoading.value = false;
		});
	try {
		const [loadedSettings, loadedStatus] = await Promise.all([
			api.playbackSettings(),
			api.playbackStatus(),
		]);
		Object.assign(settings, loadedSettings);
		savedSettings.value = { ...loadedSettings };
		status.value = loadedStatus;
		error.value = '';
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		initialLoading.value = false;
	}
	await preferenceLoad;
}

/** Clear local anonymous viewing history after styled modal confirmation. */
async function clearViewingPreferences(): Promise<void> {
	if (clearingPreferences.value || !(await requestConfirmation({
		key: 'clear-viewing-history',
		title: 'Clear Viewing History?',
		message: 'Permanently remove all learned viewing preferences? This cannot be undone.',
		confirmLabel: 'Clear History',
		destructive: true,
	}))) {
		return;
	}

	clearingPreferences.value = true;
	message.value = '';
	error.value = '';
	try {
		await api.clearViewingPreferences();
		preferences.value = [];
		message.value = 'Viewing history cleared.';
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		clearingPreferences.value = false;
	}
}

/** Format one decayed preference score for an understandable compact ranking. */
function preferenceScore(value: number): string {
	return value.toFixed(value >= 10 ? 1 : 2);
}

/** Refresh engine state without replacing an edited capacity value. */
async function refreshStatus(): Promise<void> {
	if (refreshingStatus) {
		return;
	}

	refreshingStatus = true;
	try {
		status.value = await api.playbackStatus();
		error.value = '';
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		refreshingStatus = false;
	}
}

/** Persist one settings panel while retaining drafts owned by the other panel. */
async function save(section: 'playback' | 'viewing-preferences'): Promise<void> {
	const baseline = savedSettings.value;
	const sectionDirty = section === 'playback'
		? playbackSettingsDirty.value && playbackSettingsValid.value
		: viewingPreferenceSettingsDirty.value;
	if (!baseline || savingSection.value || !sectionDirty) {
		return;
	}

	const submitted = { ...settings };
	savingSection.value = section;
	message.value = '';
	error.value = '';
	try {
		const authoritative = await api.savePlaybackSettings({
			maxActiveSessions: section === 'playback'
				? submitted.maxActiveSessions
				: baseline.maxActiveSessions,
			viewingPreferencesEnabled: section === 'viewing-preferences'
				? submitted.viewingPreferencesEnabled
				: baseline.viewingPreferencesEnabled,
		});
		savedSettings.value = { ...authoritative };
		if (
			section === 'playback'
			&& settings.maxActiveSessions === submitted.maxActiveSessions
		) {
			settings.maxActiveSessions = authoritative.maxActiveSessions;
		}
		if (
			section === 'viewing-preferences'
			&& settings.viewingPreferencesEnabled === submitted.viewingPreferencesEnabled
		) {
			settings.viewingPreferencesEnabled = authoritative.viewingPreferencesEnabled;
		}
		message.value = section === 'playback'
			? 'Playback settings saved.'
			: 'Viewing preference settings saved.';
		if (section === 'playback') {
			await refreshStatus();
		}
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		savingSection.value = null;
	}
}

/** Copy a client URL to the clipboard. */
async function copyUrl(value: string, label: string): Promise<void> {
	message.value = '';
	error.value = '';
	try {
		await navigator.clipboard.writeText(value);
		message.value = `${label} copied.`;
	}
	catch {
		error.value = `Unable to copy ${label.toLowerCase()}.`;
	}
}

const unsubscribe = liveEvents.subscribe((event) => {
	if (event.type === 'system.ready' || event.type === 'playback.changed') {
		void refreshStatus();
	}
});

onMounted(() => {
	void load();
	statusRefreshTimer = setInterval(() => void refreshStatus(), STATUS_REFRESH_INTERVAL_MS);
});
onUnmounted(() => {
	unsubscribe();
	if (statusRefreshTimer) {
		clearInterval(statusRefreshTimer);
	}
});
</script>

<template>
	<section>
		<PageHeader
			eyebrow="Integrated playback"
			title="IPTV service"
			description="Moirai serves the channel playlist, guide, and live streams directly."
		>
			<button class="button secondary" :disabled="initialLoading" @click="refreshStatus">
				<RefreshCw :size="17" />Refresh Status
			</button>
		</PageHeader>
		<p v-if="error" class="notice error">{{ error }}</p>
		<LoadingState v-if="initialLoading" label="Loading playback settings…" />
		<div v-else class="settings-layout async-state-surface">
			<form class="panel form-grid" @submit.prevent="save('playback')">
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
					<button class="button" :disabled="savingSection !== null || !playbackSettingsDirty || !playbackSettingsValid"><Save :size="17" />Save Settings</button>
				</div>
			</form>
			<aside class="panel playback-card">
				<p class="eyebrow">Playback engine</p>
				<StatusPill :value="status?.status ?? 'degraded'" />
				<h2>{{ status?.activeSessionCount ?? 0 }}/{{ status?.maxActiveSessions ?? settings.maxActiveSessions }} channels active</h2>
				<p v-if="status?.engineVersion">{{ status.engineVersion }}</p>
				<p v-if="status?.detail" class="notice warning">{{ status.detail }}</p>
				<code>{{ status?.contractRevision.slice(0, 12) }}</code>
			</aside>
			<section class="panel viewing-preferences-panel span-2">
				<p class="eyebrow">Local viewing preferences</p>
				<h2>Learn what viewers choose</h2>
				<p>Moirai anonymously scores media that remains tuned for at least two minutes. Network addresses and client details are never stored in viewing history.</p>
				<label class="settings-toggle">
					<input v-model="settings.viewingPreferencesEnabled" type="checkbox" />
					<span>Learn from channel viewing and apply it to Weighted Random programs</span>
				</label>
				<div class="form-actions"><button type="button" class="button" :disabled="savingSection !== null || !viewingPreferenceSettingsDirty" @click="save('viewing-preferences')"><Save :size="17" />Save Settings</button></div>
				<p v-if="preferencesLoading">Loading learned preferences…</p>
				<p v-else-if="preferencesError" class="notice error">{{ preferencesError }}</p>
				<p v-else-if="preferences.length === 0" class="muted">No qualified viewing has been recorded yet.</p>
				<ol v-else class="viewing-preference-list">
					<li v-for="preference in preferences" :key="`${preference.kind}:${preference.id}`">
						<span><strong>{{ preference.title }}</strong><small>{{ preference.kind === 'show' ? 'Show' : 'Item' }} · Last viewed {{ new Date(preference.lastViewedAt).toLocaleDateString() }}</small></span>
						<output>{{ preferenceScore(preference.score) }}</output>
					</li>
				</ol>
				<div class="viewing-preference-danger">
					<strong>Clear all viewing history</strong>
					<p>This permanently removes every learned preference.</p>
					<button type="button" class="button secondary" :disabled="clearingPreferences" @click="clearViewingPreferences"><Trash2 :size="17" />{{ clearingPreferences ? 'Clearing…' : 'Clear History' }}</button>
				</div>
			</section>
		</div>
		<TransientToast v-if="message" :message="message" @close="message = ''" />
	</section>
</template>
