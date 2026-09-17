<script setup lang="ts">
import { onBeforeRouteLeave } from 'vue-router';
import { useDraftProtection } from '../draft-protection';
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { Copy, RefreshCw, Save } from '@lucide/vue';
import type {
	PlaybackEngineStatus,
	PlaybackSettings,
	ViewingPreferenceSummary,
	FallbackFillerStatus,
} from '@moirai/shared';
import { playbackSettingsSchema } from '@moirai/shared';
import { useFieldValidation, numericInputAttributes } from '../field-validation';
import { api } from '../api';
import { requestConfirmation } from '../confirmation';
import { errorMessage } from '../error-message';
import LoadingState from '../components/LoadingState.vue';
import FallbackFillerEditor from '../components/FallbackFillerEditor.vue';
import PageHeader from '../components/PageHeader.vue';
import StatusPill from '../components/StatusPill.vue';
import TransientToast from '../components/TransientToast.vue';
import TwoStepActionButton from '../components/TwoStepActionButton.vue';
import ViewingPreferenceScoresModal from '../components/ViewingPreferenceScoresModal.vue';
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
const settingsLoadError = ref('');
const statusError = ref('');
const statusLoading = ref(true);
const saveErrors = reactive({ playback: '', 'viewing-preferences': '' });
const clipboardError = ref('');
const historyError = ref('');
const capacityValidation = useFieldValidation(() => playbackSettingsSchema.safeParse(settings));
const capacityAttributes = numericInputAttributes(playbackSettingsSchema.shape.maxActiveSessions.removeDefault());
const preferences = ref<ViewingPreferenceSummary[]>([]);
const preferencesLoading = ref(false);
const preferencesError = ref('');
const scoresOpen = ref(false);
const clearingPreferences = ref(false);
const fallbackStatus = ref<FallbackFillerStatus | null>(null);
const fallbackFile = ref<File | null>(null);
const removeFallbackOnSave = ref(false);
const fallbackLoading = ref(true);
const savingFallback = ref(false);
const fallbackError = ref('');
const fallbackLoadError = ref('');
const playbackSettingsDirty = computed(() => savedSettings.value !== null
	&& settings.maxActiveSessions !== savedSettings.value.maxActiveSessions);
const playbackSettingsValid = computed(() => playbackSettingsSchema.shape.maxActiveSessions.safeParse(settings.maxActiveSessions).success);
const viewingPreferenceSettingsDirty = computed(() => savedSettings.value !== null
	&& settings.viewingPreferencesEnabled !== savedSettings.value.viewingPreferencesEnabled);
const fallbackDirty = computed(() => fallbackFile.value !== null || removeFallbackOnSave.value);
const refreshingStatus = ref(false);
let loadingSettings = false;
let preferenceLoadSequence = 0;
let fallbackLoadSequence = 0;
let statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
/** Polling interval that keeps client activity current without following every segment request. */
const STATUS_REFRESH_INTERVAL_MS = 15_000;

/** Retry settings without replacing drafts owned by other resources. */
async function loadSettings(): Promise<void> {
	if (loadingSettings) {
		return;
	}
	loadingSettings = true;
	initialLoading.value = true;
	try {
		const loaded = await api.playbackSettings();
		Object.assign(settings, loaded);
		savedSettings.value = { ...loaded };
		settingsLoadError.value = '';
		capacityValidation.reset();
	}
	catch (cause) {
		settingsLoadError.value = errorMessage(cause);
	}
	finally {
		initialLoading.value = false;
		loadingSettings = false;
	}
}

/** Open the ranked scores dialog and load the current history. */
function openScores(): void {
	scoresOpen.value = true;
	void loadPreferences();
}

/** Load learned history independently of the editable playback settings. */
async function loadPreferences(title = ''): Promise<void> {
	if (clearingPreferences.value) {
		return;
	}

	const sequence = ++preferenceLoadSequence;
	preferencesLoading.value = true;
	try {
		const loaded = await api.viewingPreferences(20, title);
		if (sequence !== preferenceLoadSequence) {
			return;
		}

		preferences.value = loaded;
		preferencesError.value = '';
	}
	catch (cause) {
		if (sequence !== preferenceLoadSequence) {
			return;
		}

		preferencesError.value = errorMessage(cause);
	}
	finally {
		if (sequence === preferenceLoadSequence) {
			preferencesLoading.value = false;
		}
	}
}

/** Refresh global fallback metadata without allowing an older request to replace newer state. */
async function refreshFallback(showLoading = false): Promise<void> {
	const sequence = ++fallbackLoadSequence;
	if (showLoading) {
		fallbackLoading.value = true;
	}

	try {
		const loadedFallback = await api.globalFallbackFiller();
		if (sequence !== fallbackLoadSequence) {
			return;
		}

		fallbackStatus.value = loadedFallback;
		fallbackLoadError.value = '';
	}
	catch (cause) {
		if (sequence === fallbackLoadSequence) {
			fallbackLoadError.value = errorMessage(cause);
		}
	}
	finally {
		if (sequence === fallbackLoadSequence) {
			fallbackLoading.value = false;
		}
	}
}

/** Discard the staged fallback replacement or removal without changing the active override. */
function resetFallbackDraft(): void {
	fallbackFile.value = null;
	removeFallbackOnSave.value = false;
	fallbackError.value = '';
}

/** Apply the staged global fallback replacement or removal. */
async function saveFallback(): Promise<void> {
	if (!fallbackDirty.value || savingFallback.value || savingSection.value !== null) {
		return;
	}

	savingFallback.value = true;
	message.value = '';
	fallbackError.value = '';
	try {
		fallbackStatus.value = fallbackFile.value
			? await api.uploadGlobalFallbackFiller(fallbackFile.value)
			: await api.deleteGlobalFallbackFiller();
		fallbackLoadError.value = '';
		fallbackFile.value = null;
		removeFallbackOnSave.value = false;
		message.value = 'Global fallback filler saved.';
	}
	catch (cause) {
		fallbackError.value = errorMessage(cause);
	}
	finally {
		savingFallback.value = false;
	}
}

/** Permanently remove learned viewing history after the two-step scores-dialog control. */
async function clearViewingPreferences(): Promise<void> {
	if (clearingPreferences.value) {
		return;
	}

	clearingPreferences.value = true;
	message.value = '';
	historyError.value = '';
	try {
		await api.clearViewingPreferences();
		preferences.value = [];
		preferencesError.value = '';
		message.value = 'Viewing history cleared.';
	}
	catch (cause) {
		historyError.value = errorMessage(cause);
	}
	finally {
		clearingPreferences.value = false;
	}
}

/** Refresh engine state without replacing an edited capacity value. */
async function refreshStatus(): Promise<void> {
	if (refreshingStatus.value) {
		return;
	}

	refreshingStatus.value = true;
	try {
		status.value = await api.playbackStatus();
		statusError.value = '';
	}
	catch (cause) {
		statusError.value = errorMessage(cause);
	}
	finally {
		refreshingStatus.value = false;
		statusLoading.value = false;
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
	saveErrors[section] = '';
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
		saveErrors[section] = errorMessage(cause);
	}
	finally {
		savingSection.value = null;
	}
}

/** Copy a client URL to the clipboard. */
async function copyUrl(value: string, label: string): Promise<void> {
	message.value = '';
	clipboardError.value = '';
	try {
		await navigator.clipboard.writeText(value);
		message.value = `${label} copied.`;
	}
	catch {
		clipboardError.value = `Unable to copy ${label.toLowerCase()}.`;
	}
}

const unsubscribe = liveEvents.subscribe((event) => {
	if (event.type === 'system.ready' || event.type === 'playback.changed') {
		void refreshStatus();
	}
	if (
		event.type === 'system.ready'
		|| (event.type === 'playback.changed'
			&& event.data.reason === 'fallback-applied'
			&& event.data.channelId === null)
	) {
		void refreshFallback();
	}
});

onMounted(() => {
	void loadSettings();
	void refreshStatus();
	void refreshFallback(true);
	statusRefreshTimer = setInterval(() => void refreshStatus(), STATUS_REFRESH_INTERVAL_MS);
});
onUnmounted(() => {
	unsubscribe();
	if (statusRefreshTimer) {
		clearInterval(statusRefreshTimer);
	}
});
const unsavedSections = computed(() => [
	playbackSettingsDirty.value ? 'playback capacity' : '',
	viewingPreferenceSettingsDirty.value ? 'viewing preferences' : '',
	fallbackDirty.value ? 'fallback filler' : '',
].filter(Boolean));
useDraftProtection(() => unsavedSections.value.length > 0);
onBeforeRouteLeave(async () => !savingSection.value && !savingFallback.value && (!unsavedSections.value.length || await requestConfirmation({
	key: 'discard-settings',
	title: 'Discard Unsaved Changes?',
	message: `Leave without saving changes to ${unsavedSections.value.join(', ')}?`,
	confirmLabel: 'Discard Changes',
	cancelLabel: 'Keep Editing',
	destructive: true,
})));
</script>

<template>
	<section>
		<PageHeader
			eyebrow="Integrated playback"
			title="Settings"
			description="Moirai serves the channel playlist, guide, and live streams directly."
		>
			<button class="button secondary" :disabled="refreshingStatus" @click="refreshStatus">
				<RefreshCw :size="17" />Refresh Status
			</button>
		</PageHeader>
		<div class="settings-layout async-state-surface">
			<form class="panel form-grid" @submit.prevent="save('playback')">
				<div class="span-2">
					<p class="eyebrow">Client setup</p>
					<h2>Playlist and guide</h2>
					<p>Add these URLs to an IPTV client that can reach this Moirai server.</p>
				</div>
				<p v-if="clipboardError" class="notice error span-2" role="alert">{{ clipboardError }}</p>
				<LoadingState v-if="statusLoading" class="span-2" label="Loading client URLs…" />
				<template v-if="status">
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
				</template>
				<LoadingState v-if="initialLoading" class="span-2" label="Loading playback settings…" />
				<div v-else-if="settingsLoadError" class="span-2"><p class="notice error" role="alert">{{ settingsLoadError }}</p><button type="button" class="button secondary" @click="loadSettings">Retry Settings</button></div>
				<label v-if="savedSettings" class="span-2">
					<span>Maximum active channel sessions</span>
					<input v-model.number="settings.maxActiveSessions" type="number" v-bind="{ ...capacityAttributes, ...capacityValidation.attributes('maxActiveSessions') }" />
					<small v-if="capacityValidation.error('maxActiveSessions')" :id="capacityValidation.errorId('maxActiveSessions')" class="field-error">{{ capacityValidation.error('maxActiveSessions') }}</small>
					<small>Additional tune requests receive a retryable capacity response. Default: 4.</small>
				</label>
				<p v-if="saveErrors.playback" class="notice error span-2" role="alert">{{ saveErrors.playback }}</p>
				<div v-if="savedSettings" class="form-actions span-2">
					<button class="button" :disabled="savingSection !== null || !playbackSettingsDirty || !playbackSettingsValid"><Save :size="17" />Save Settings</button>
				</div>
			</form>
			<aside class="panel playback-card">
				<p class="eyebrow">Playback engine</p>
				<LoadingState v-if="statusLoading" label="Loading playback status…" />
				<div v-if="statusError"><p class="notice error" role="alert">{{ statusError }}</p><button type="button" class="button secondary" :disabled="refreshingStatus" @click="refreshStatus">Retry Status</button></div>
				<template v-if="status">
					<StatusPill :value="status.status" />
					<h2>
						{{ status?.activeSessionCount ?? 0 }}/{{ status?.maxActiveSessions ?? settings.maxActiveSessions }}
						{{ (status?.activeSessionCount ?? 0) === 1 ? 'stream' : 'streams' }} active
					</h2>
					<p v-if="status?.engineVersion">{{ status.engineVersion }}</p>
					<p v-if="status?.detail" class="notice warning">{{ status.detail }}</p>
					<code>{{ status.contractRevision.slice(0, 12) }}</code>
				</template>
			</aside>
			<section class="panel fallback-filler-panel span-2">
				<p class="eyebrow">Playback safety</p>
				<h2>Global fallback filler</h2>
				<p>Used when a channel has no channel-specific fallback and its schedule leaves time uncovered.</p>
				<FallbackFillerEditor
					v-model:selected-file="fallbackFile"
					v-model:remove-on-save="removeFallbackOnSave"
					heading="Global fallback override"
					removal-source="Bundled Moirai fallback after save"
					:status="fallbackStatus"
					:loading="fallbackLoading"
					:disabled="savingFallback || savingSection !== null"
					@validation-error="fallbackError = $event"
				/>
				<p v-if="fallbackError" class="notice error">{{ fallbackError }}</p>
				<div v-if="fallbackLoadError"><p class="notice error" role="alert">{{ fallbackLoadError }}</p><button type="button" class="button secondary" :disabled="fallbackLoading || savingFallback" @click="refreshFallback(true)">Retry Fallback</button></div>
				<div class="form-actions">
					<TwoStepActionButton
						class="button secondary"
						label="Reset fallback draft"
						confirm-label="Confirm Reset fallback draft"
						confirm-text="Confirm Reset"
						tone="caution"
						:disabled="!fallbackDirty || savingFallback || savingSection !== null"
						@confirm="resetFallbackDraft"
					>
						<RefreshCw :size="17" />Reset
					</TwoStepActionButton>
					<button
						type="button"
						class="button"
						:disabled="!fallbackDirty || savingFallback || savingSection !== null"
						@click="saveFallback"
					>
						<Save :size="17" />{{ savingFallback ? 'Saving…' : 'Save Fallback' }}
					</button>
				</div>
			</section>
			<section class="panel viewing-preferences-panel span-2">
				<p class="eyebrow">Local viewing preferences</p>
				<h2>Learn what viewers choose</h2>
				<p>Moirai anonymously scores media that remains tuned for at least two minutes. Network addresses and client details are never stored in viewing history.</p>
				<label v-if="savedSettings" class="settings-toggle">
					<input v-model="settings.viewingPreferencesEnabled" type="checkbox" />
					<span>Learn from channel viewing and apply it to Weighted Random programs</span>
				</label>
				<p v-if="saveErrors['viewing-preferences']" class="notice error" role="alert">{{ saveErrors['viewing-preferences'] }}</p>
				<div v-if="savedSettings" class="form-actions viewing-preference-actions">
					<button type="button" class="button secondary" @click="openScores">View Current Scores</button>
					<button type="button" class="button" :disabled="savingSection !== null || !viewingPreferenceSettingsDirty" @click="save('viewing-preferences')"><Save :size="17" />Save Settings</button>
				</div>
				<p v-if="historyError" class="notice error" role="alert">{{ historyError }}</p>
			</section>
		</div>
		<ViewingPreferenceScoresModal
			v-if="scoresOpen"
			:preferences="preferences"
			:loading="preferencesLoading"
			:clearing="clearingPreferences"
			:error="preferencesError"
			:clear-error="historyError"
			@close="scoresOpen = false"
			@search="loadPreferences"
			@clear="clearViewingPreferences"
		/>
		<TransientToast v-if="message" :message="message" @close="message = ''" />
	</section>
</template>
