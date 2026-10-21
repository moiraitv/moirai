<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ChevronDown, RefreshCw, MonitorPlay, Clapperboard, Heart, Languages } from '@lucide/vue';
import type {
	PlaybackEngineStatus,
	PlaybackSettings,
	ViewingPreferenceSummary,
	FallbackFillerStatus,
} from '@moirai/shared';
import { DEFAULT_FILLER_SHORTFALL_WARNING_THRESHOLD_PERCENT, playbackSettingsSchema } from '@moirai/shared';
import { useFieldValidation, numericInputAttributes } from '../field-validation';
import { api } from '../api';
import { errorMessage } from '../error-message';
import LoadingState from './LoadingState.vue';
import AudioPreferencesEditor from './AudioPreferencesEditor.vue';
import { cloneContractValue } from '../reactive-clone';
import FillerWarningSettings from './FillerWarningSettings.vue';
import FallbackFillerEditor from './FallbackFillerEditor.vue';
import FormDisclosure from './FormDisclosure.vue';
import EngineDetailsPopover from './EngineDetailsPopover.vue';
import StatusPill from './StatusPill.vue';
import SettingsSaveFooter from './SettingsSaveFooter.vue';
import PageHelpButton from './PageHelpButton.vue';
import ViewingPreferenceScoresModal from './ViewingPreferenceScoresModal.vue';
import { liveEvents } from '../live-events';

const settings = reactive<PlaybackSettings>({
	audioPreferences: {},
	maxActiveSessions: 4,
	viewingPreferencesEnabled: true,
	fillerShortfallWarningThresholdPercent: DEFAULT_FILLER_SHORTFALL_WARNING_THRESHOLD_PERCENT,
});
const savedSettings = ref<PlaybackSettings | null>(null);
const audioResetRevision = ref(0);
const status = ref<PlaybackEngineStatus | null>(null);
const initialLoading = ref(true);
const saving = ref(false);
const emit = defineEmits<{ dirty: [value: boolean]; saving: [value: boolean]; attention: [value: boolean]; saved: [message: string] }>();
const warningOpen = ref(false);
const fallbackOpen = ref(false);
const settingsLoadError = ref('');
const statusError = ref('');
const statusLoading = ref(true);
const saveError = ref('');
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
const fallbackError = ref('');
const fallbackLoadError = ref('');
const audioSettingsDirty = computed(() => savedSettings.value !== null
	&& (settings.audioPreferences.language !== savedSettings.value.audioPreferences.language
		|| settings.audioPreferences.title !== savedSettings.value.audioPreferences.title));
const audioSettingsValid = computed(() => playbackSettingsSchema.shape.audioPreferences.safeParse(settings.audioPreferences).success);
const playbackSettingsDirty = computed(() => savedSettings.value !== null
	&& settings.maxActiveSessions !== savedSettings.value.maxActiveSessions);
const playbackSettingsValid = computed(() => playbackSettingsSchema.shape.maxActiveSessions.safeParse(settings.maxActiveSessions).success);
const viewingPreferenceSettingsDirty = computed(() => savedSettings.value !== null
	&& settings.viewingPreferencesEnabled !== savedSettings.value.viewingPreferencesEnabled);
const fillerSettingsDirty = computed(() => savedSettings.value !== null
	&& settings.fillerShortfallWarningThresholdPercent !== savedSettings.value.fillerShortfallWarningThresholdPercent);
const fallbackDirty = computed(() => fallbackFile.value !== null || removeFallbackOnSave.value);
const fillerBlockDirty = computed(() => fillerSettingsDirty.value || fallbackDirty.value);
const valid = computed(() => savedSettings.value !== null && !initialLoading.value
	&& playbackSettingsSchema.safeParse(settings).success
	&& (!fallbackDirty.value || (!fallbackLoading.value && !fallbackLoadError.value && !fallbackError.value)));
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
		Object.assign(settings, cloneContractValue(loaded));
		savedSettings.value = cloneContractValue(loaded);
		audioResetRevision.value += 1;
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

/** Restore every playback field and staged fallback to the latest saved baseline. */
function reset(): void {
	if (savedSettings.value) {
		Object.assign(settings, cloneContractValue(savedSettings.value));
		audioResetRevision.value += 1;
	}
	fallbackFile.value = null;
	removeFallbackOnSave.value = false;
	fallbackError.value = '';
	saveError.value = '';
	capacityValidation.reset();
}

/** Permanently remove learned viewing history after the two-step scores-dialog control. */
async function clearViewingPreferences(): Promise<void> {
	if (clearingPreferences.value) {
		return;
	}

	clearingPreferences.value = true;
	historyError.value = '';
	try {
		await api.clearViewingPreferences();
		preferences.value = [];
		preferencesError.value = '';
		emit('saved', 'Viewing history cleared.');
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

/** Save the complete tab, retaining unsaved settings if publishing the fallback only partly succeeds. */
async function save(): Promise<void> {
	const baseline = savedSettings.value;
	if (!baseline || saving.value || !dirty.value || !valid.value) {
		return;
	}

	const submitted = cloneContractValue(settings);
	const submittedFile = fallbackFile.value;
	const submittedRemoval = removeFallbackOnSave.value;
	const settingsChanged = audioSettingsDirty.value || playbackSettingsDirty.value || viewingPreferenceSettingsDirty.value || fillerSettingsDirty.value;
	saving.value = true;
	saveError.value = '';
	let fallbackSaved = false;
	try {
		// Publish the fallback first so a failed upload never commits the remaining drafts.
		if (submittedFile || submittedRemoval) {
			fallbackStatus.value = submittedFile
				? await api.uploadGlobalFallbackFiller(submittedFile)
				: await api.deleteGlobalFallbackFiller();
			fallbackLoadError.value = '';
			if (fallbackFile.value === submittedFile && removeFallbackOnSave.value === submittedRemoval) {
				fallbackFile.value = null;
				removeFallbackOnSave.value = false;
			}
			fallbackSaved = true;
		}

		// Persist all playback settings in one existing request and capture the acknowledged baseline.
		const authoritative = settingsChanged ? await api.savePlaybackSettings(submitted) : baseline;
		savedSettings.value = cloneContractValue(authoritative);
		if (JSON.stringify(settings.audioPreferences) === JSON.stringify(submitted.audioPreferences)) {
			settings.audioPreferences = cloneContractValue(authoritative.audioPreferences);
			audioResetRevision.value += 1;
		}
		if (settings.maxActiveSessions === submitted.maxActiveSessions) {
			settings.maxActiveSessions = authoritative.maxActiveSessions;
		}
		if (settings.viewingPreferencesEnabled === submitted.viewingPreferencesEnabled) {
			settings.viewingPreferencesEnabled = authoritative.viewingPreferencesEnabled;
		}
		if (settings.fillerShortfallWarningThresholdPercent === submitted.fillerShortfallWarningThresholdPercent) {
			settings.fillerShortfallWarningThresholdPercent = authoritative.fillerShortfallWarningThresholdPercent;
		}
		emit('saved', 'Playback settings saved.');
		if (submitted.maxActiveSessions !== baseline.maxActiveSessions) {
			await refreshStatus();
		}
	}
	catch (cause) {
		saveError.value = fallbackSaved
			? `Fallback saved, but playback settings could not be saved. ${errorMessage(cause)}`
			: errorMessage(cause);
	}
	finally {
		saving.value = false;
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
const dirty = computed(() => audioSettingsDirty.value || playbackSettingsDirty.value || viewingPreferenceSettingsDirty.value || fillerBlockDirty.value);
watch(dirty, value => emit('dirty', value), { immediate: true });
watch(saving, value => emit('saving', value), { immediate: true });
watch(() => Boolean(settingsLoadError.value || statusError.value || status.value?.detail
	|| fallbackLoadError.value || fallbackError.value || fallbackStatus.value?.overrideError
	|| (savedSettings.value && (!playbackSettingsValid.value || !audioSettingsValid.value))
	|| historyError.value || preferencesError.value || saveError.value), value => emit('attention', value), { immediate: true });

/** Describe the saved fallback without exposing a staged upload as persisted. */
const fallbackSummary = computed(() => fallbackLoading.value ? 'Loading…'
	: fallbackLoadError.value ? 'Unavailable'
		: fallbackStatus.value?.overrideConfigured ? fallbackStatus.value.effective.filename : 'Bundled Moirai fallback');
</script>

<template>
	<form class="settings-playback settings-tab-editor" novalidate @submit.prevent="save">
		<div class="settings-status">
			<LoadingState v-if="statusLoading" label="Loading playback status…" />
			<div v-if="status" class="settings-status-title"><StatusPill :value="status.status" /><strong>{{ status.activeSessionCount }}/{{ status.maxActiveSessions }} streams active</strong><PageHelpButton label="Playback status" topic-id="settings.playback#playback-status" /></div>
			<button type="button" class="button secondary" :disabled="refreshingStatus" @click="refreshStatus"><RefreshCw :size="17" />Refresh Status</button>
			<EngineDetailsPopover :version="status?.engineVersion" :revision="status?.contractRevision" />
			<p v-if="status?.detail" class="notice warning">{{ status.detail }}</p>
			<p v-if="statusError" class="notice error" role="alert">{{ statusError }}</p>
		</div>
		<div class="settings-playback-groups" data-disclosure-layout>
			<section class="panel settings-section form-grid settings-capacity">
				<header class="settings-card-heading span-2">
					<span class="settings-card-icon"><MonitorPlay :size="24" aria-hidden="true" /></span>
					<div><div class="settings-card-title"><h2>Playback capacity</h2><PageHelpButton label="Playback capacity" topic-id="settings.playback#playback-capacity" /></div><p>Set how many channel streams can play at once.</p></div>
				</header>
				<LoadingState v-if="initialLoading" class="span-2" label="Loading playback settings…" />
				<div v-else-if="settingsLoadError" class="span-2"><p class="notice error" role="alert">{{ settingsLoadError }}</p><button type="button" class="button secondary" @click="loadSettings">Retry Settings</button></div>
				<label v-if="savedSettings" class="settings-capacity-field">
					<span>Maximum active channel sessions</span>
					<input v-model.number="settings.maxActiveSessions" type="number" v-bind="{ ...capacityAttributes, ...capacityValidation.attributes('maxActiveSessions') }" />
					<small v-if="capacityValidation.error('maxActiveSessions')" :id="capacityValidation.errorId('maxActiveSessions')" class="field-error">{{ capacityValidation.error('maxActiveSessions') }}</small>
					<small>Additional tune requests receive a retryable capacity response. Default: 4.</small>
				</label>
			</section>
			<section class="panel settings-section form-grid">
				<header class="settings-card-heading span-2">
					<span class="settings-card-icon"><Languages :size="24" aria-hidden="true" /></span>
					<div><div class="settings-card-title"><h2>Audio selection defaults</h2><PageHelpButton label="Audio selection defaults" topic-id="settings.playback#audio-selection-defaults" /></div><p>Choose the default audio language and track title. Channels and programs can override each field.</p></div>
				</header>
				<LoadingState v-if="initialLoading" class="span-2" label="Loading audio selection defaults…" />
				<p v-else-if="settingsLoadError" class="notice error span-2" role="alert">{{ settingsLoadError }}</p>
				<AudioPreferencesEditor v-else-if="savedSettings" v-model="settings.audioPreferences" class="span-2" unframed :disabled="saving" :reset-revision="audioResetRevision" />
			</section>
			<section class="panel settings-section fallback-filler-panel">
				<header class="settings-card-heading"><span class="settings-card-icon"><Clapperboard :size="24" aria-hidden="true" /></span><div class="settings-card-title"><h2>Filler</h2><PageHelpButton label="Filler" topic-id="settings.playback#filler" /></div></header>
				<FormDisclosure v-model:open="warningOpen" data-disclosure-item>
					<template #summary><span>Break budget warnings</span><span class="settings-summary">{{ initialLoading ? 'Loading…' : settingsLoadError ? 'Unavailable' : `Below ${savedSettings?.fillerShortfallWarningThresholdPercent}%` }}<span v-if="fillerSettingsDirty"> · Unsaved</span><ChevronDown :size="17" /></span></template>
					<FillerWarningSettings
						v-model="settings.fillerShortfallWarningThresholdPercent"
						:baseline="savedSettings?.fillerShortfallWarningThresholdPercent ?? null"
						:loading="initialLoading"
						:load-error="settingsLoadError"
						:busy="saving"
						@retry="loadSettings"
					/>
				</FormDisclosure>
				<FormDisclosure v-model:open="fallbackOpen" data-disclosure-item>
					<template #summary><span>Global fallback filler</span><span class="settings-summary">{{ fallbackSummary }}<span v-if="fallbackDirty"> · Unsaved</span><ChevronDown :size="17" /></span></template>
					<p>Used when a channel has no channel-specific fallback and its schedule leaves time uncovered.</p>
					<FallbackFillerEditor
						v-model:selected-file="fallbackFile"
						v-model:remove-on-save="removeFallbackOnSave"
						heading="Global fallback override"
						removal-source="Bundled Moirai fallback after save"
						:status="fallbackStatus"
						:loading="fallbackLoading"
						:disabled="saving"
						@validation-error="fallbackError = $event"
					/>
				</FormDisclosure>
				<p v-if="fallbackStatus?.overrideError" class="notice warning">{{ fallbackStatus.overrideError }}</p>
				<p v-if="fallbackError" class="notice error">{{ fallbackError }}</p>
				<div v-if="fallbackLoadError"><p class="notice error" role="alert">{{ fallbackLoadError }}</p><button type="button" class="button secondary" :disabled="fallbackLoading || saving" @click="refreshFallback(true)">Retry Fallback</button></div>
			</section>
			<section class="panel settings-section viewing-preferences-panel" data-disclosure-item>
				<header class="settings-card-heading">
					<span class="settings-card-icon"><Heart :size="24" aria-hidden="true" /></span>
					<div><div class="settings-card-title"><h2>Viewing preferences</h2><PageHelpButton label="Viewing preferences" topic-id="settings.playback#viewing-preferences" /></div><p>Use anonymous viewing history in future selections. Network addresses and client details are never stored.</p></div>
				</header>
				<label v-if="savedSettings" class="settings-toggle">
					<input v-model="settings.viewingPreferencesEnabled" type="checkbox" aria-label="Learn from channel viewing and apply it to Weighted Random programs" />
					<span>Learn from channel viewing</span>
				</label>
				<div v-if="savedSettings" class="form-actions viewing-preference-actions">
					<button type="button" class="button secondary" @click="openScores">View Current Scores</button>
				</div>
				<p v-if="historyError" class="notice error" role="alert">{{ historyError }}</p>
			</section>
		</div>
		<p v-if="saveError" class="notice error" role="alert">{{ saveError }}</p>
		<SettingsSaveFooter label="Playback" :dirty="dirty" :valid="valid" :busy="saving" :saving="saving" :ready="savedSettings !== null && !initialLoading" @reset="reset" />
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
	</form>
</template>
