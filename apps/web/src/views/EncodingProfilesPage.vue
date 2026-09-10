<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { Copy, Eye, Info, Monitor, Pencil, Plus, Settings } from '@lucide/vue';
import { onBeforeRouteLeave } from 'vue-router';
import { encodingProfileCreateSchema, audioNormalizationSchema, videoNormalizationSchema, type EncodingProfile } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import { requestConfirmation } from '../confirmation';
import { closeUnsavedEditor } from '../unsaved-editor';
import PageHeader from '../components/PageHeader.vue';
import LoadingState from '../components/LoadingState.vue';
import ResourceEditorHeader from '../components/ResourceEditorHeader.vue';
import ResourceEditorActionBar from '../components/ResourceEditorActionBar.vue';
import EncodingSettingsEditor from '../components/EncodingSettingsEditor.vue';
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
const form = reactive({ name: '', description: '', audio: audioNormalizationSchema.parse({}), video: videoNormalizationSchema.parse({}) });
const baseline = ref('');
const dirty = computed(() => JSON.stringify(form) !== baseline.value);
const valid = computed(() => encodingProfileCreateSchema.safeParse(form).success);
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
async function edit(profile?: EncodingProfile, duplicate = false): Promise<void> {
	opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	id.value = duplicate ? undefined : profile?.id;
	readonlyPreset.value = Boolean(profile?.isBuiltin && !duplicate);
	form.name = profile ? profile.name + (duplicate ? ' copy' : '') : 'New encoding profile';
	form.description = profile?.description ?? '';
	form.audio = profile ? cloneContractValue(profile.audio) : audioNormalizationSchema.parse({});
	form.video = profile ? cloneContractValue(profile.video) : videoNormalizationSchema.parse({});
	baseline.value = JSON.stringify(form);
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
	await edit(profile, true);
	opener = collectionOpener;
}

/** Close and restore focus after a completed save or confirmed discard. */
function dismiss(): void {
	open.value = false;
	opener?.focus();
}

/** Save the full validated draft and return to the updated collection. */
async function save(): Promise<void> {
	if (busy.value || readonlyPreset.value || !valid.value) {
		return;
	}
	busy.value = true;
	editorError.value = '';
	try {
		if (id.value) {
			await api.updateEncodingProfile(id.value, form);
		}
		else {
			await api.createEncodingProfile(form);
		}
		baseline.value = JSON.stringify(form);
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

/** Route close, backdrop, Escape, and navigation through one draft-discard flow. */
async function close(): Promise<void> {
	await closeUnsavedEditor({ blocked: busy.value, dirty: dirty.value, key: 'encoding-profile',
		message: 'Save changes to this encoding profile?', save, discard: dismiss });
}

/** Confirm permanent removal; referenced profiles remain intact on a conflict. */
async function remove(): Promise<void> {
	if (!id.value || !(await requestConfirmation({ title: 'Delete Encoding Profile?', message: `Delete ${form.name} and discard unsaved changes?`, confirmLabel: 'Delete Encoding Profile', destructive: true }))) {
		return;
	}
	busy.value = true;
	try {
		await api.deleteEncodingProfile(id.value);
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

/** Let styled confirmation dialogs consume Escape before dismissing the editor. */
function keydown(event: KeyboardEvent): void {
	if (open.value && event.key === 'Escape' && !event.defaultPrevented) {
		event.preventDefault();
		void close();
	}
}
onMounted(() => {
	void load();
	window.addEventListener('keydown', keydown); 
});
onBeforeUnmount(() => window.removeEventListener('keydown', keydown));
onBeforeRouteLeave(async () => {
	if (open.value) {
		await close(); 
	}
	return !open.value; 
});
</script>

<template>
	<div>
		<PageHeader title="Encoding profiles" description="Reuse audio and video settings across channels."><button class="button" type="button" :disabled="busy" @click="edit()"><Plus :size="20" aria-hidden="true" />New profile</button></PageHeader>
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
			<form class="moirai-dialog resource-editor-modal encoding-profile-editor" role="dialog" aria-modal="true" aria-labelledby="encoding-editor-title" @submit.prevent="save">
				<ResourceEditorHeader close-label="Close encoding profile" :disabled="busy" @close="close"><div class="encoding-editor-title"><h2 id="encoding-editor-title">{{ readonlyPreset ? 'View' : id ? 'Edit' : 'New' }} encoding profile</h2><span v-if="readonlyPreset" class="encoding-profile-badge builtin-badge">Built-in</span></div></ResourceEditorHeader>
				<div class="resource-editor-scroll">
					<div class="encoding-profile-metadata"><label><span>Name</span><input ref="nameInput" v-model="form.name" :disabled="readonlyPreset" required maxlength="120" /></label>
						<label><span>Description</span><input v-model="form.description" type="text" :disabled="busy || readonlyPreset" maxlength="500" placeholder="Describe when to use this profile" /></label></div>
					<p v-if="readonlyPreset" class="encoding-profile-info"><Info :size="22" aria-hidden="true" /><span>Built-in presets are read-only. Duplicate this preset to customize its settings.</span></p>
					<p v-else>Saving changes updates every channel using this profile. Choose Custom on a channel to keep its settings independent.</p>
					<p v-if="!readonlyPreset && isCurrentDefault">Choose another default before deleting this profile.</p>
					<EncodingSettingsEditor v-model:audio="form.audio" v-model:video="form.video" :disabled="busy || readonlyPreset" />
					<p v-if="editorError" class="notice error">{{ editorError }}</p>
				</div>
				<ResourceEditorActionBar v-if="!readonlyPreset" resource-type="Encoding Profile" :show-delete="Boolean(id) && !isCurrentDefault" :busy="busy" :saving="busy" :reset-disabled="!dirty" :save-disabled="!valid || (Boolean(id) && !dirty)" save-submits @reset="Object.assign(form, JSON.parse(baseline))" @delete="remove" />
				<footer v-if="readonlyPreset" class="resource-editor-action-bar encoding-profile-view-actions"><button class="button secondary" type="button" @click="close">Close</button><button class="button secondary" type="button" @click="duplicateViewedProfile"><Copy :size="20" aria-hidden="true" />Duplicate</button></footer>
			</form>
		</div>
	</div>
</template>
