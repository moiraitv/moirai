<script setup lang="ts">
import { useDraftProtection } from '../draft-protection';
import PageHelpButton from '../components/PageHelpButton.vue';
import { useDisclosureState } from '../disclosure-state';
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { Copy, Eye, FileCode, Info, Pencil, Plus } from '@lucide/vue';
import { onBeforeRouteLeave } from 'vue-router';
import { creditTemplateCreateSchema, MAX_CREDIT_TEMPLATE_LENGTH, MUSIC_VIDEO_CREDIT_TEMPLATE, type CreditTemplate } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import { requestConfirmation } from '../confirmation';
import { closeUnsavedEditor } from '../unsaved-editor';
import PageHeader from '../components/PageHeader.vue';
import LoadingState from '../components/LoadingState.vue';
import ResourceEditorHeader from '../components/ResourceEditorHeader.vue';
import ResourceEditorActionBar from '../components/ResourceEditorActionBar.vue';
import CreditTemplatePreview from '../components/CreditTemplatePreview.vue';

const metadataOpen = useDisclosureState('credit-template-metadata');

const templates = ref<CreditTemplate[]>([]);
const loaded = ref(false);
const error = ref('');
const editorError = ref('');
const open = ref(false);
const id = ref<string>();
const readonlyTemplate = ref(false);
const busy = ref(false);
const previewBusy = ref(false);
const nameInput = ref<HTMLInputElement>();
const form = reactive({ name: '', description: '', source: '' });
const baseline = ref('');
const dirty = computed(() => JSON.stringify(form) !== baseline.value);
const valid = computed(() => creditTemplateCreateSchema.safeParse(form).success);
let opener: HTMLElement | null = null;

/** Load templates without displaying an empty state before successful retrieval. */
async function load(): Promise<void> {
	try {
		templates.value = await api.creditTemplates();
		loaded.value = true;
		error.value = '';
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

/** Open a saved template or a new editable copy of the converted starter. */
async function edit(template?: CreditTemplate, duplicate = false): Promise<void> {
	opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	id.value = duplicate ? undefined : template?.id;
	readonlyTemplate.value = Boolean(template?.isBuiltin && !duplicate);
	form.description = template?.description ?? '';
	form.name = template ? template.name + (duplicate ? ' copy' : '') : 'New credit template';
	form.source = template?.source ?? MUSIC_VIDEO_CREDIT_TEMPLATE;
	baseline.value = JSON.stringify(form);
	editorError.value = '';
	open.value = true;
	await nextTick();
	if (readonlyTemplate.value) {
		document.querySelector<HTMLButtonElement>('.credit-template-editor .resource-editor-close')?.focus();
	}
	else {
		nameInput.value?.focus();
	}
}

/** Open an independent copy and retain the collection opener for focus restoration. */
async function duplicateViewedTemplate(): Promise<void> {
	const template = templates.value.find((entry) => entry.id === id.value);
	if (!template) {
		return;
	}
	const collectionOpener = opener;
	await edit(template, true);
	opener = collectionOpener;
}

/** Close and restore focus after a completed save or confirmed discard. */
function dismiss(): void {
	open.value = false;
	opener?.focus();
}

/** Save the full validated draft and return to the updated collection. */
async function save(): Promise<void> {
	if (busy.value || previewBusy.value || readonlyTemplate.value || !valid.value) {
		return;
	}
	busy.value = true;
	editorError.value = '';
	try {
		if (id.value) {
			await api.updateCreditTemplate(id.value, form);
		}
		else {
			await api.createCreditTemplate(form);
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
	await closeUnsavedEditor({ blocked: busy.value || previewBusy.value, dirty: dirty.value, key: 'credit-template',
		message: 'Save changes to this credit template?', save, discard: dismiss });
}

/** Confirm permanent removal; referenced templates remain intact on a conflict. */
async function remove(): Promise<void> {
	if (!id.value || !(await requestConfirmation({ title: 'Delete Credit Template?', message: `Delete ${form.name} and discard unsaved changes?`, confirmLabel: 'Delete Credit Template', destructive: true }))) {
		return;
	}
	busy.value = true;
	try {
		await api.deleteCreditTemplate(id.value);
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

onMounted(() => {
	void load();
});
onBeforeRouteLeave(async () => {
	if (open.value) {
		await close(); 
	}
	return !open.value; 
});
useDraftProtection(() => open.value && !readonlyTemplate.value && dirty.value);
</script>

<template>
	<div>
		<PageHeader title="Credit templates" description="Create styled artist, song, and album credits for music videos."><button class="button" type="button" :disabled="busy" @click="edit()"><Plus :size="20" aria-hidden="true" />New template</button></PageHeader>
		<p v-if="error" class="notice error">{{ error }} <button type="button" class="button secondary" @click="load">Retry</button></p>
		<LoadingState v-if="!loaded && !error" />
		<div v-if="loaded" class="credit-template-list">
			<p v-if="!templates.length">No credit templates yet. Create one from the included music video design.</p>
			<article v-for="template in templates" :key="template.id" class="panel credit-template-card">
				<header><span class="credit-template-icon" aria-hidden="true"><FileCode :size="28" /></span><h2>{{ template.name }}</h2><span v-if="template.isBuiltin" class="credit-template-badge">Built-in</span></header>
				<p class="credit-template-description">{{ template.description }}</p>
				<div class="form-actions"><button class="button" type="button" :disabled="busy" @click="edit(template)"><component :is="template.isBuiltin ? Eye : Pencil" :size="19" aria-hidden="true" />{{ template.isBuiltin ? 'View' : 'Edit' }}</button><button class="button secondary" type="button" :disabled="busy" @click="edit(template, true)"><Copy :size="19" aria-hidden="true" />Duplicate</button></div>
			</article>
		</div>
		<div v-if="open" class="moirai-dialog-backdrop" @click.self="close">
			<form v-modal-focus="{ escape: close }" class="moirai-dialog resource-editor-modal credit-template-editor" role="dialog" aria-modal="true" aria-labelledby="credit-editor-title" @submit.prevent="save">
				<ResourceEditorHeader close-label="Close credit template" :disabled="busy || previewBusy" @close="close"><div class="credit-template-title"><div class="resource-editor-title-with-help"><h2 id="credit-editor-title">{{ readonlyTemplate ? 'View' : id ? 'Edit' : 'New' }} credit template</h2><PageHelpButton label="Credit templates" topic-id="playback.credit-templates" /></div><span v-if="readonlyTemplate" class="credit-template-badge">Built-in</span></div></ResourceEditorHeader>
				<div class="resource-editor-scroll">
					<div class="credit-template-metadata"><label><span>Name</span><input ref="nameInput" v-model="form.name" :disabled="busy || readonlyTemplate" required maxlength="120" /></label><label><span>Description</span><input v-model="form.description" type="text" :disabled="busy || readonlyTemplate" maxlength="500" placeholder="Describe when to use this template" /></label></div>
					<p v-if="readonlyTemplate" class="credit-template-info"><Info :size="22" aria-hidden="true" /><span>Built-in templates are read-only. Duplicate this template to customize its credits.</span></p>
					<label><span class="credit-template-source-label"><FileCode :size="20" aria-hidden="true" />Credit template (Liquid)</span><textarea v-model="form.source" :readonly="readonlyTemplate" :disabled="busy" class="credit-template-source" :maxlength="MAX_CREDIT_TEMPLATE_LENGTH" spellcheck="false" required /></label>
					<p>Use Liquid expressions and tags to generate subtitles in Advanced SubStation Alpha (ASS) format. Text values are escaped automatically. Use <code>ass_time</code> to format seconds. Credits use fixed source time and require Burn mode.</p>
					<details :open="metadataOpen" @toggle="metadataOpen = ($event.target as HTMLDetailsElement).open"><summary>Available metadata and fonts</summary><p><code>resolution.width</code>, <code>resolution.height</code>, <code>title</code>, <code>artist</code>, <code>all_artists</code>, <code>album</code>, <code>track</code>, <code>plot</code>, <code>release_date.year</code>, <code>studios</code>, <code>directors</code>, <code>duration.total_seconds</code>. Guard missing release dates with an if condition. Font names must match fonts installed on the server or in the channel’s subtitle fonts folder.</p></details>
					<CreditTemplatePreview :source="form.source" @busy="previewBusy = $event" />
					<p v-if="editorError" class="notice error">{{ editorError }}</p>
				</div>
				<ResourceEditorActionBar v-if="!readonlyTemplate" resource-type="Credit Template" :show-delete="Boolean(id)" :busy="busy || previewBusy" :saving="busy" :reset-disabled="!dirty" :save-disabled="!valid || (Boolean(id) && !dirty)" save-submits @reset="Object.assign(form, JSON.parse(baseline))" @delete="remove" />
				<footer v-if="readonlyTemplate" class="resource-editor-action-bar credit-template-view-actions"><button class="button secondary" type="button" :disabled="previewBusy" @click="close">Close</button><button class="button secondary" type="button" :disabled="previewBusy" @click="duplicateViewedTemplate"><Copy :size="20" aria-hidden="true" />Duplicate</button></footer>
			</form>
		</div>
	</div>
</template>
