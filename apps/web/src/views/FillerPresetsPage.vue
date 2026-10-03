<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { Copy, Eye, Pencil, Plus } from '@lucide/vue';
import { BUILTIN_MID_ROLL_PRESETS, BUILTIN_FILLER_PRESETS, anyFillerPresetCreateSchema, type AnyFillerPreset, type AnyFillerPresetCreate, type FillerKind } from '@moirai/shared';
import { api } from '../api';
import { cloneContractValue } from '../reactive-clone';
import { errorMessage } from '../error-message';
import { requestConfirmation } from '../confirmation';
import { closeUnsavedEditor } from '../unsaved-editor';
import { useDraftProtection } from '../draft-protection';
import PageHelpButton from '../components/PageHelpButton.vue';
import PageHeader from '../components/PageHeader.vue';
import LoadingState from '../components/LoadingState.vue';
import ResourceUsage from '../components/ResourceUsage.vue';
import ResourceEditorHeader from '../components/ResourceEditorHeader.vue';
import ResourceEditorActionBar from '../components/ResourceEditorActionBar.vue';
import { fillerBudgetSummary } from '../filler-budget';
import FillerBudgetEditor from '../components/schedules/FillerBudgetEditor.vue';
import MidRollSettingsEditor from '../components/schedules/MidRollSettingsEditor.vue';

const props = withDefaults(defineProps<{ kind?: FillerKind }>(), { kind: 'mid-roll' });
const label = computed(() => ({ 'mid-roll': 'Mid-Roll', 'pre-roll': 'Pre-Roll', 'post-roll': 'Post-Roll', tail: 'Tail Filler' })[props.kind]);
const defaultPreset = computed<AnyFillerPresetCreate>(() => props.kind === 'mid-roll' ? { ...BUILTIN_MID_ROLL_PRESETS[0]!, kind: 'mid-roll' } : BUILTIN_FILLER_PRESETS.find(preset => preset.kind === props.kind)!);
const presets = ref<AnyFillerPreset[]>([]);
const loaded = ref(false);
const error = ref('');
const editorError = ref('');
const open = ref(false);
const busy = ref(false);
const id = ref<string>();
const readonlyPreset = ref(false);
const form = ref<AnyFillerPresetCreate>(cloneContractValue(defaultPreset.value));
const baseline = ref('');
const dirty = computed(() => JSON.stringify(form.value) !== baseline.value);
const validation = computed(() => anyFillerPresetCreateSchema.safeParse(form.value));
const validationError = computed(() => validation.value.success ? '' : validation.value.error.issues[0]?.message ?? 'Review the Mid-Roll settings');
const nameInput = ref<HTMLInputElement>();
let opener: HTMLElement | null = null;

/** Retrieve the collection while keeping loading and failures distinct from empty results. */
async function load(): Promise<void> {
	error.value = '';
	try {
		presets.value = await api.fillerPresets(props.kind);
		loaded.value = true;
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

/** Capture an independent baseline for a new, existing, or duplicated preset. */
async function edit(preset?: AnyFillerPreset, duplicate = false): Promise<void> {
	opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	id.value = duplicate ? undefined : preset?.id;
	readonlyPreset.value = Boolean(preset?.isBuiltin && !duplicate);
	const source = preset ?? defaultPreset.value;
	form.value = cloneContractValue({ ...source, name: preset ? preset.name + (duplicate ? ' copy' : '') : `New ${label.value}` });
	baseline.value = JSON.stringify(form.value);
	editorError.value = '';
	open.value = true;
	await nextTick();
	if (readonlyPreset.value) {
		document.querySelector<HTMLButtonElement>('.mid-roll-preset-editor .resource-editor-close')?.focus();
	}
	else {
		nameInput.value?.focus();
	}
}

/** Duplicate the viewed resource while retaining the collection focus destination. */
async function duplicateViewed(): Promise<void> {
	const preset = presets.value.find(entry => entry.id === id.value);
	if (preset) {
		const collectionOpener = opener;
		await edit(preset, true);
		opener = collectionOpener;
	}
}

/** Dismiss a completed or discarded draft and restore its opener. */
function dismiss(): void {
	open.value = false;
	opener?.focus();
}

/** Persist a validated custom draft and reconcile the displayed collection. */
async function save(): Promise<void> {
	if (busy.value || readonlyPreset.value || !validation.value.success || !dirty.value) {
		return;
	}
	busy.value = true;
	editorError.value = '';
	try {
		const saved = id.value ? await api.updateFillerPreset(id.value, validation.value.data)
			: await api.createFillerPreset(validation.value.data);
		presets.value = [...presets.value.filter(entry => entry.id !== saved.id), saved]
			.sort((left, right) => Number(right.isBuiltin) - Number(left.isBuiltin) || left.name.localeCompare(right.name));
		baseline.value = JSON.stringify(form.value);
		dismiss();
	}
	catch (cause) {
		editorError.value = errorMessage(cause);
	}
	finally {
		busy.value = false;
	}
}

/** Share draft protection across close, backdrop, Escape, and route navigation. */
async function close(): Promise<void> {
	await closeUnsavedEditor({ blocked: busy.value, dirty: !readonlyPreset.value && dirty.value, key: 'mid-roll-preset',
		message: `Save changes to this ${label.value}?`, save, discard: dismiss });
}

/** Confirm permanent custom-preset deletion and retain reference conflicts in context. */
async function remove(): Promise<void> {
	if (!id.value || !(await requestConfirmation({ title: `Delete ${label.value}?`,
		message: `Delete ${form.value.name} and discard unsaved changes?`, confirmLabel: `Delete ${label.value}`, destructive: true }))) {
		return;
	}
	busy.value = true;
	editorError.value = '';
	try {
		await api.deleteFillerPreset(id.value);
		presets.value = presets.value.filter(entry => entry.id !== id.value);
		dismiss();
	}
	catch (cause) {
		editorError.value = errorMessage(cause);
	}
	finally {
		busy.value = false;
	}
}

onMounted(load);
onBeforeRouteLeave(async () => {
	if (open.value) {
		await close();
	}
	return !open.value;
});
useDraftProtection(() => open.value && !readonlyPreset.value && dirty.value);
</script>

<template>
	<div class="mid-roll-presets-page">
		<PageHeader :title="`${label}s`" description="Reuse filler budgets with different source Programs."><button type="button" class="button" :disabled="busy || !loaded" @click="edit()"><Plus :size="20" />New {{ label }}</button></PageHeader>
		<LoadingState v-if="!loaded && !error" :label="`Loading ${label}s…`" />
		<p v-if="error" class="notice error">{{ error }} <button type="button" @click="load">Retry</button></p>
		<div v-if="loaded" class="mid-roll-preset-list">
			<p v-if="presets.length === 0">No {{ label }}s yet.</p>
			<article v-for="preset in presets" :key="preset.id" class="panel mid-roll-preset-card">
				<header><h2>{{ preset.name }}</h2><span v-if="preset.isBuiltin" class="encoding-profile-badge builtin-badge">Built-in</span></header>
				<p>{{ preset.description }}</p>
				<p>{{ fillerBudgetSummary(preset.budget) }}<template v-if="preset.kind === 'mid-roll'"> · {{ preset.fallbackIntervalSeconds }}-second timed fallback</template></p>
				<div class="form-actions"><button type="button" class="button" @click="edit(preset)"><component :is="preset.isBuiltin ? Eye : Pencil" :size="19" />{{ preset.isBuiltin ? 'View' : 'Edit' }}</button><button type="button" class="button secondary" @click="edit(preset, true)"><Copy :size="19" />Duplicate</button></div>
			</article>
		</div>
		<div v-if="open" class="moirai-dialog-backdrop" @click.self="close">
			<form v-modal-focus="{ escape: close }" class="moirai-dialog resource-editor-modal mid-roll-preset-editor" role="dialog" aria-modal="true" aria-labelledby="mid-roll-preset-title" @submit.prevent="save">
				<ResourceEditorHeader :close-label="`Close ${label}`" :disabled="busy" @close="close"><div class="resource-editor-title-with-help"><h2 id="mid-roll-preset-title">{{ readonlyPreset ? 'View' : id ? 'Edit' : 'New' }} {{ label }}</h2><PageHelpButton :label="`${label}s`" topic-id="filler.presets" /></div></ResourceEditorHeader>
				<div class="resource-editor-scroll"><ResourceUsage kind="filler-preset" :resource-id="id ?? undefined">
					<p v-if="readonlyPreset">Built-in {{ label }}s are read-only. Duplicate this {{ label }} to customize its settings.</p>
					<div class="form-grid"><label class="resource-primary-field"><span>Name</span><input ref="nameInput" v-model="form.name" :disabled="busy || readonlyPreset" maxlength="120" required /></label><label><span>Description</span><input v-model="form.description" :disabled="busy || readonlyPreset" maxlength="500" /></label></div>
					<p v-if="id && !readonlyPreset">Changing break settings affects every assignment using this {{ label }}. Existing airings finish before pending settings apply.</p>
					<MidRollSettingsEditor v-if="form.kind === 'mid-roll'" :model-value="form" :disabled="busy || readonlyPreset" @update:model-value="form = { ...form, ...$event }" />
					<fieldset v-if="form.kind !== 'mid-roll'" :disabled="busy || readonlyPreset" class="mid-roll-settings"><legend>Filler Settings</legend><FillerBudgetEditor :model-value="form.budget" :allow-remaining="kind === 'tail'" @update:model-value="form = { ...form, budget: $event }" /></fieldset>
					<p v-if="validationError" class="notice error" role="alert">{{ validationError }}</p><p v-if="editorError" class="notice error">{{ editorError }}</p>
				</ResourceUsage></div>
				<ResourceEditorActionBar v-if="!readonlyPreset" :resource-type="label" :show-delete="Boolean(id)" :busy="busy" :saving="busy" :reset-disabled="!dirty" :save-disabled="!validation.success || !dirty" save-submits @reset="form = JSON.parse(baseline)" @delete="remove" />
				<footer v-else class="resource-editor-action-bar"><button type="button" class="button secondary" @click="close">Close</button><button type="button" class="button secondary" @click="duplicateViewed"><Copy :size="19" />Duplicate</button></footer>
			</form>
		</div>
	</div>
</template>
