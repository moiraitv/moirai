<script setup lang="ts">
import { useResourceDraft } from '../composables/useResourceDraft';
import { useRoute } from 'vue-router';
import { readWithRetry } from '../read-recovery';
import ResourceUsage from '../components/ResourceUsage.vue';
import { useDraftProtection } from '../draft-protection';
import PageHelpButton from '../components/PageHelpButton.vue';
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { Copy, Eye, Info, Monitor, Pencil, Plus, Settings } from '@lucide/vue';
import { useResourceEditorRoute } from '../composables/useResourceEditorRoute';
import { encodingProfileCreateSchema, audioNormalizationSchema, videoNormalizationSchema, type EncodingProfile } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import { requestConfirmation } from '../confirmation';
import { closeUnsavedEditor } from '../unsaved-editor';
import ManagementPageHeader from '../components/ManagementPageHeader.vue';
import LoadingState from '../components/LoadingState.vue';
import ResourceEditorHeader from '../components/ResourceEditorHeader.vue';
import ResourceEditorActionBar from '../components/ResourceEditorActionBar.vue';
import EncodingSettingsEditor from '../components/EncodingSettingsEditor.vue';
import { useHardwareAccelerationPrediction } from '../channel-acceleration';
import { cloneContractValue } from '../reactive-clone';

/** Present the recommended HD presets before the remaining resolution choices. */
const presetOrder = [1080, 720, 480, 576, 1440, 2160];
const profiles = ref<EncodingProfile[]>([]);
const loaded = ref(false);
const error = ref('');
const editorError = ref('');
const open = ref(false);
const id = ref<string>();
const busy = ref(false);
const readonlyPreset = ref(false);
const displayProfiles = computed(() => [...profiles.value].sort((left, right) =>
	Number(right.isDefault) - Number(left.isDefault) || Number(right.isBuiltin) - Number(left.isBuiltin)
	|| (left.isBuiltin && right.isBuiltin
		? presetOrder.indexOf(left.video.height ?? 0) - presetOrder.indexOf(right.video.height ?? 0)
		: left.name.localeCompare(right.name))));
const selectedDefault = computed(() => profiles.value.find((profile) => profile.isDefault)?.id ?? '');
const isCurrentDefault = computed(() => Boolean(id.value && id.value === selectedDefault.value));
const nameInput = ref<HTMLInputElement>();
const encodingInvalid = ref(false);
const form = reactive({ name: '', description: '', audio: audioNormalizationSchema.parse({}), video: videoNormalizationSchema.parse({}) });
const { prediction: accelerationPrediction, text: accelerationPredictionText } = useHardwareAccelerationPrediction(
	() => open.value && form.video.accel === 'automatic' ? {
		format: form.video.format,
		bitDepth: form.video.bitDepth,
		width: form.video.width,
		height: form.video.height,
		vaapiDevice: form.video.vaapiDevice,
		vaapiDriver: form.video.vaapiDriver,
		ffmpegPath: null,
	} : null,
);
const baseline = ref('');
const dirty = computed(() => JSON.stringify(form) !== baseline.value);
const valid = computed(() => encodingProfileCreateSchema.safeParse(form).success);
const route = useRoute();
const retained = useResourceDraft({
	kind: 'encoding-profile', identity: () => id.value ?? `new:${String(route.query.duplicate ?? '')}`,
	nullableSchema: encodingProfileCreateSchema,
	capture: () => form, restore: fields => {
		Object.assign(form, fields);
	}, dirty: () => dirty.value,
});
const { warning: draftWarning } = retained;

let opener: HTMLElement | null = null;

/** Load profiles without displaying an empty state before successful retrieval. */
async function load(): Promise<void> {
	try {
		profiles.value = await api.encodingProfiles();
		loaded.value = true;
		error.value = '';
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

/** Open a saved profile or a new editable copy of the default encoding settings. */
async function openDraft(profile?: EncodingProfile, duplicate = false): Promise<void> {
	retained.pause();
	opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	id.value = duplicate ? undefined : profile?.id;
	readonlyPreset.value = Boolean(profile?.isBuiltin && !duplicate);
	form.name = profile ? profile.name + (duplicate ? ' copy' : '') : 'New encoding profile';
	form.description = profile?.description ?? '';
	form.audio = profile ? cloneContractValue(profile.audio) : audioNormalizationSchema.parse({});
	form.video = profile ? cloneContractValue(profile.video) : videoNormalizationSchema.parse({});
	baseline.value = JSON.stringify(form);
	if (!readonlyPreset.value) {
		await retained.open(baseline.value);
	}
	editorError.value = '';
	open.value = true;
	await nextTick();
	if (readonlyPreset.value) {
		document.querySelector<HTMLButtonElement>('.encoding-profile-editor .resource-editor-close')?.focus();
	}
	else {
		nameInput.value?.focus();
	}
}

/** Start an editable copy while retaining the collection control for focus restoration. */
async function duplicateViewedProfile(): Promise<void> {
	const profile = profiles.value.find((entry) => entry.id === id.value);
	if (!profile) {
		return;
	}
	const collectionOpener = opener;
	await editorRoute.navigate(profile, true);
	opener = collectionOpener;
}

/** Close and restore focus after a completed save or confirmed discard. */
function dismiss(): void {
	retained.pause();
	open.value = false;
	opener?.focus();
	editorRoute.finish();
}

/** Commit the validated draft and retain the editor at its saved identity. */
async function save(): Promise<void> {
	if (busy.value || readonlyPreset.value || !valid.value || (id.value && !dirty.value)) {
		return;
	}
	busy.value = true;
	editorError.value = '';
	try {
		const saved = id.value
			? await api.updateEncodingProfile(id.value, form)
			: await api.createEncodingProfile(form);
		const index = profiles.value.findIndex(entry => entry.id === saved.id);
		if (index < 0) {
			profiles.value.push(saved);
		}
		else {
			profiles.value[index] = saved;
		}
		retained.clear();
		Object.assign(form, { name: saved.name, description: saved.description, audio: cloneContractValue(saved.audio), video: cloneContractValue(saved.video) });
		id.value = saved.id;
		baseline.value = JSON.stringify(form);
		await editorRoute.adopt(saved.id);
		await retained.open(baseline.value, false);
		try {
			profiles.value = await readWithRetry(() => api.encodingProfiles());
			loaded.value = true;
			error.value = '';
		}
		catch (cause) {
			error.value = `Saved, but the list could not be refreshed. ${errorMessage(cause)}`;
		}
	}
	catch (cause) {
		editorError.value = errorMessage(cause);
	}
	finally {
		busy.value = false;
	}
}

/** Retain pending work on dismissal, protecting it with a prompt only if retention fails. */
async function close(): Promise<void> {
	await closeUnsavedEditor({ retainedDraft: retained, isDirty: () => dirty.value, blocked: busy.value, dirty: dirty.value, key: 'encoding-profile',
		message: 'Save changes to this encoding profile?', save, discard: dismiss });
}

/** Discard pending changes and retain the latest committed baseline. */
function resetDraft(): void {
	retained.clear();
	Object.assign(form, JSON.parse(baseline.value));
	void retained.open(baseline.value, false);
}

/** Confirm permanent removal; referenced profiles remain intact on a conflict. */
async function remove(): Promise<void> {
	if (!id.value || !(await requestConfirmation({ title: 'Delete Encoding Profile?', message: `Delete ${form.name} and discard unsaved changes?`, confirmLabel: 'Delete Encoding Profile', destructive: true }))) {
		return;
	}
	busy.value = true;
	try {
		await api.deleteEncodingProfile(id.value);
		retained.clear();
		dismiss();
		await load();
	}
	catch (cause) {
		editorError.value = errorMessage(cause);
	}
	finally {
		busy.value = false;
	}
}

/** Change only the default used for future channels, retaining failures beside the control. */
async function setDefault(event: Event): Promise<void> {
	busy.value = true;
	error.value = '';
	try {
		await api.setDefaultEncodingProfile((event.target as HTMLSelectElement).value);
		await load();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		(event.target as HTMLSelectElement).value = selectedDefault.value;
		busy.value = false;
	}
}

onMounted(() => {
	void load();
});
const editorRoute = useResourceEditorRoute({
	basePath: () => '/playback/encoding-profiles', resources: () => profiles.value, ready: () => loaded.value,
	isOpen: () => open.value, open: openDraft, close,
	onMissing: () => {
		error.value = 'Resource not found. It may have been deleted.';
	},
});

/** Open a resource through its canonical editor path. */
function edit(profile?: EncodingProfile, duplicate = false): void {
	void editorRoute.navigate(profile, duplicate);
}
useDraftProtection(() => open.value && !readonlyPreset.value && dirty.value && retained.unsafe.value);
</script>

<template>
	<div>
		<ManagementPageHeader section="Playback" title="Encoding Profiles" description="Reuse audio and video settings across channels."><button class="button" type="button" :disabled="busy" @click="edit()"><Plus :size="20" aria-hidden="true" />New Profile</button></ManagementPageHeader>
		<p v-if="error" class="notice error">{{ error }} <button type="button" class="button secondary" @click="load">Retry</button></p>
		<LoadingState v-if="!loaded && !error" />
		<section v-if="loaded" class="panel encoding-default-panel">
			<span class="encoding-profile-icon" aria-hidden="true"><Settings :size="26" /></span>
			<div class="encoding-default-control"><label><span>Default for new channels</span><select :value="selectedDefault" :disabled="busy" @change="setDefault"><option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option></select></label>
				<p>Used by new channels and Quick Setup. Changing the default does not change existing channels.</p></div>
		</section>
		<div v-if="loaded" class="encoding-profile-list">
			<p v-if="!profiles.length">No encoding profiles yet. Channels can continue using their own Custom settings.</p>
			<article v-for="profile in displayProfiles" :key="profile.id" class="panel encoding-profile-card" :class="{ 'is-default': profile.isDefault }">
				<header class="encoding-profile-card-header">
					<span class="encoding-profile-icon" aria-hidden="true"><Monitor :size="28" /></span>
					<div class="encoding-profile-heading"><div class="encoding-profile-title"><h2>{{ profile.name }}</h2><span v-if="profile.isDefault" class="encoding-profile-badge default-badge">Default</span></div>
						<p class="encoding-profile-specs">{{ profile.video.width }} × {{ profile.video.height }} · {{ profile.video.format === 'h264' ? 'H.264' : profile.video.format?.toUpperCase() }} · {{ profile.audio.format?.toUpperCase() }}</p>
					</div>
					<span v-if="profile.isBuiltin" class="encoding-profile-badge builtin-badge">Built-in</span>
				</header>
				<p class="encoding-profile-description">{{ profile.description }}</p>
				<div class="form-actions"><button class="button" type="button" :disabled="busy" @click="edit(profile)"><component :is="profile.isBuiltin ? Eye : Pencil" :size="19" aria-hidden="true" />{{ profile.isBuiltin ? 'View' : 'Edit' }}</button><button class="button secondary" type="button" :disabled="busy" @click="edit(profile, true)"><Copy :size="19" aria-hidden="true" />Duplicate</button></div>
			</article>
		</div>
		<div v-if="open" class="moirai-dialog-backdrop" @click.self="close">
			<form v-modal-focus="{ escape: close }" class="moirai-dialog resource-editor-modal encoding-profile-editor" role="dialog" aria-modal="true" aria-labelledby="encoding-editor-title" @submit.prevent="save">
				<ResourceEditorHeader close-label="Close encoding profile" :disabled="busy" @close="close"><div class="encoding-editor-title"><div class="resource-editor-title-with-help"><h2 id="encoding-editor-title">{{ readonlyPreset ? 'View' : id ? 'Edit' : 'New' }} Encoding Profile</h2><PageHelpButton label="Encoding profiles" topic-id="playback.encoding-profiles" /></div><span v-if="readonlyPreset" class="encoding-profile-badge builtin-badge">Built-in</span></div></ResourceEditorHeader>
				<div :inert="busy" class="resource-editor-scroll">
					<ResourceUsage kind="encoding-profile" :resource-id="id ?? undefined">
						<p v-if="readonlyPreset" class="encoding-profile-info"><Info :size="22" aria-hidden="true" /><span>Built-in presets are read-only. Duplicate this preset to customize its settings.</span></p>
						<div class="encoding-profile-metadata"><label class="resource-primary-field"><span>Name</span><input ref="nameInput" v-model="form.name" :disabled="readonlyPreset" required maxlength="120" /></label>
							<label><span>Description</span><input v-model="form.description" type="text" :disabled="busy || readonlyPreset" maxlength="500" placeholder="Describe when to use this profile" /></label></div>
						<p v-if="!readonlyPreset && id" class="encoding-profile-usage-note">Saving changes updates every channel using this profile. Choose Custom on a channel to keep its settings independent.</p>
						<p v-if="!readonlyPreset && isCurrentDefault">Choose another default before deleting this profile.</p>
						<EncodingSettingsEditor v-model:audio="form.audio" v-model:video="form.video" :disabled="busy || readonlyPreset" :acceleration-prediction-text="accelerationPredictionText" :acceleration-detail="accelerationPrediction?.detail" @validation-change="encodingInvalid = $event" />
						<p v-if="editorError" class="notice error">{{ editorError }}</p>
					</ResourceUsage>
				</div>
				<ResourceEditorActionBar v-if="!readonlyPreset" :pending="!id || dirty" :draft-warning="draftWarning" :draft-restored="retained.recovered.value" :save-label="id ? 'Save' : 'Add'" :validation-message="encodingInvalid ? 'Correct the highlighted video or audio settings before saving.' : ''" resource-type="Encoding Profile" :show-delete="Boolean(id) && !isCurrentDefault" :busy="busy" :saving="busy" :reset-disabled="!dirty" :save-disabled="!valid || (Boolean(id) && !dirty)" save-submits @close="close" @reset="resetDraft" @delete="remove" />
				<footer v-if="readonlyPreset" class="resource-editor-action-bar encoding-profile-view-actions"><button class="button secondary" type="button" @click="close"><span>Close</span></button><button class="button secondary" type="button" @click="duplicateViewedProfile"><Copy :size="20" aria-hidden="true" /><span>Duplicate</span></button></footer>
			</form>
		</div>
	</div>
</template>
