<script setup lang="ts">
import { readWithRetry } from '../read-recovery';
import ResourceUsage from '../components/ResourceUsage.vue';
import { useDraftProtection } from '../draft-protection';
import PageHelpButton from '../components/PageHelpButton.vue';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { Copy, Eye, FileCode, Info, Pencil, Plus } from '@lucide/vue';
import { onBeforeRouteLeave } from 'vue-router';
import {
	BUILTIN_GUIDE_TEMPLATE,
	GUIDE_TEMPLATE_SOURCE_KEYS,
	GUIDE_TEMPLATE_TAB_LABELS,
	MAX_GUIDE_TEMPLATE_SOURCE_LENGTH,
	emptyGuideTemplateSources,
	guideTemplateCreateSchema,
	type Channel,
	type GuideEntry,
	type GuideTemplate,
	type GuideTemplatePreviewValue,
	type GuideTemplateSourceKey,
	type GuideTemplateSources,
	type ScheduleGuide,
} from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import { requestConfirmation } from '../confirmation';
import { closeUnsavedEditor } from '../unsaved-editor';
import { cloneContractValue } from '../reactive-clone';
import PageHeader from '../components/PageHeader.vue';
import LoadingState from '../components/LoadingState.vue';
import ResourceEditorHeader from '../components/ResourceEditorHeader.vue';
import ResourceEditorActionBar from '../components/ResourceEditorActionBar.vue';
import GuideTimeline from '../components/GuideTimeline.vue';
import GuideTemplateValuesPopover from '../components/GuideTemplateValuesPopover.vue';

const templates = ref<GuideTemplate[]>([]);
const channels = ref<Channel[]>([]);
const channelsLoading = ref(false);
const channelsLoaded = ref(false);
const channelsError = ref('');
const loaded = ref(false);
const error = ref('');
const editorError = ref('');
const previewError = ref('');
const previewEntries = ref<GuideEntry[]>([]);
const previewChannelValues = ref<GuideTemplatePreviewValue[]>([]);
const previewListingValues = ref<Record<string, GuideTemplatePreviewValue[]>>({});
const inspectedId = ref<string | null>(null);
const previewTimeZone = ref('');
const previewStartDate = ref('');
const previewBusy = ref(false);
const previewFrame = ref<HTMLElement>();
const valuesPopover = ref<InstanceType<typeof GuideTemplateValuesPopover>>();
const previewHourWidth = ref(112);
const open = ref(false);
const id = ref<string>();
const readonlyTemplate = ref(false);
const busy = ref(false);
const activeTab = ref<GuideTemplateSourceKey>('channel');
const previewChannelId = ref('');
const nameInput = ref<HTMLInputElement>();
const form = reactive({
	name: '',
	description: '',
	sources: emptyGuideTemplateSources(),
});
const baseline = ref('');
const dirty = computed(() => JSON.stringify(form) !== baseline.value);
const valid = computed(() => guideTemplateCreateSchema.safeParse(form).success);
const selectedDefault = computed(() => templates.value.find((entry) => entry.isDefault)?.id ?? '');
const isCurrentDefault = computed(() => Boolean(id.value && id.value === selectedDefault.value));
const displayTemplates = computed(() => [...templates.value].sort((left, right) =>
	Number(right.isDefault) - Number(left.isDefault) || Number(right.isBuiltin) - Number(left.isBuiltin)
	|| left.name.localeCompare(right.name)));
const previewChannel = computed(() => channels.value.find((entry) => entry.id === previewChannelId.value) ?? null);
const previewGuide = computed((): ScheduleGuide | null => {
	if (!previewChannel.value || !previewStartDate.value || !previewTimeZone.value) {
		return null;
	}

	return {
		timeZone: previewTimeZone.value,
		startDate: previewStartDate.value,
		requestedDays: 1,
		days: 1,
		segmentLimitApplied: false,
		channels: [{
			channelId: previewChannel.value.id,
			preview: {
				channelId: previewChannel.value.id,
				timeZone: previewTimeZone.value,
				startDate: previewStartDate.value,
				days: 1,
				segments: [],
				issues: [],
				proposedState: [],
			},
			entries: previewEntries.value,
		}],
	};
});
const inspectedValues = computed(() => {
	if (inspectedId.value === 'channel') {
		return previewChannelValues.value;
	}
	return inspectedId.value ? previewListingValues.value[inspectedId.value] ?? [] : [];
});
const inspectedLabel = computed(() => {
	if (inspectedId.value === 'channel') {
		return previewChannel.value ? `${previewChannel.value.number} ${previewChannel.value.name}` : 'Channel';
	}

	return previewEntries.value.find((entry) => entry.id === inspectedId.value)?.title ?? 'Listing';
});
let opener: HTMLElement | null = null;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewSequence = 0;
let previewZoomObserver: ResizeObserver | null = null;

/** Load templates without displaying an empty state before successful retrieval. */
async function load(): Promise<void> {
	try {
		templates.value = await api.guideTemplates();
		loaded.value = true;
		error.value = '';
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

/** Load channels used by the one-day XMLTV preview selector. */
async function loadChannels(): Promise<void> {
	channelsLoading.value = true;
	channelsError.value = '';
	try {
		channels.value = await api.channels();
		channelsLoaded.value = true;
		if (!channels.value.some((channel) => channel.id === previewChannelId.value)) {
			previewChannelId.value = channels.value[0]?.id ?? '';
		}
	}
	catch (cause) {
		channelsError.value = errorMessage(cause);
	}
	finally {
		channelsLoading.value = false;
	}
	schedulePreview();
}

/** Open a saved template or a new editable copy of the built-in layout. */
async function edit(template?: GuideTemplate, duplicate = false): Promise<void> {
	opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	id.value = duplicate ? undefined : template?.id;
	readonlyTemplate.value = Boolean(template?.isBuiltin && !duplicate);
	form.description = template?.description ?? '';
	form.name = template ? template.name + (duplicate ? ' copy' : '') : 'New guide template';
	form.sources = cloneContractValue(template?.sources ?? BUILTIN_GUIDE_TEMPLATE.sources);
	activeTab.value = 'channel';
	baseline.value = JSON.stringify(form);
	editorError.value = '';
	previewError.value = '';
	previewEntries.value = [];
	previewChannelValues.value = [];
	previewListingValues.value = {};
	inspectedId.value = null;
	previewStartDate.value = '';
	open.value = true;
	await loadChannels();
	await nextTick();
	if (readonlyTemplate.value) {
		document.querySelector<HTMLButtonElement>('.guide-template-editor .resource-editor-close')?.focus();
	}
	else {
		nameInput.value?.focus();
	}
	schedulePreview();
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
	if (busy.value || readonlyTemplate.value || !valid.value) {
		return;
	}
	busy.value = true;
	editorError.value = '';
	try {
		const saved = id.value
			? await api.updateGuideTemplate(id.value, form)
			: await api.createGuideTemplate(form);
		const index = templates.value.findIndex((entry) => entry.id === saved.id);
		if (index < 0) {
			templates.value.push(saved);
		}
		else {
			templates.value[index] = saved;
		}
		baseline.value = JSON.stringify(form);
		dismiss();
		try {
			templates.value = await readWithRetry(() => api.guideTemplates());
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

/** Route close, backdrop, Escape, and navigation through one draft-discard flow. */
async function close(): Promise<void> {
	await closeUnsavedEditor({
		blocked: busy.value,
		dirty: dirty.value,
		key: 'guide-template',
		message: 'Save changes to this guide template?',
		save,
		discard: dismiss,
	});
}

/** Confirm permanent removal; referenced templates remain intact on a conflict. */
async function remove(): Promise<void> {
	if (!id.value || !(await requestConfirmation({
		title: 'Delete Guide Template?',
		message: `Delete ${form.name} and discard unsaved changes?`,
		confirmLabel: 'Delete Guide Template',
		destructive: true,
	}))) {
		return;
	}
	busy.value = true;
	try {
		await api.deleteGuideTemplate(id.value);
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

/** Change only the default used by unassigned channels. */
async function setDefault(event: Event): Promise<void> {
	busy.value = true;
	error.value = '';
	try {
		await api.setDefaultGuideTemplate((event.target as HTMLSelectElement).value);
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

/** Restore the captured opening draft after two-step confirmation. */
function resetDraft(): void {
	Object.assign(form, JSON.parse(baseline.value) as { name: string; description: string; sources: GuideTemplateSources });
}

/** Size the preview so four elapsed hours fill the timeline track. */
function updatePreviewZoom(): void {
	const frame = previewFrame.value;
	if (!frame) {
		return;
	}

	const channelWidth = frame.querySelector<HTMLElement>('.guide-corner')?.offsetWidth ?? 160;
	const track = Math.max(0, frame.clientWidth - channelWidth);
	previewHourWidth.value = Math.max(48, track / 4);
}

/** Observe the preview frame so 4-hour zoom tracks the editor width. */
function observePreviewZoom(): void {
	previewZoomObserver?.disconnect();
	if (!previewFrame.value) {
		return;
	}

	previewZoomObserver = new ResizeObserver(() => {
		updatePreviewZoom();
	});
	previewZoomObserver.observe(previewFrame.value);
	updatePreviewZoom();
}

/** Queue a formatted one-day preview against the selected channel. */
function schedulePreview(): void {
	clearTimeout(previewTimer);
	if (!open.value || channelsLoading.value || !channelsLoaded.value || channelsError.value) {
		return;
	}
	previewTimer = setTimeout(() => {
		void runPreview();
	}, 400);
}

/** Render draft sources against the selected channel’s committed local day. */
async function runPreview(): Promise<void> {
	if (channelsLoading.value || !channelsLoaded.value || channelsError.value) {
		return;
	}

	if (!previewChannelId.value) {
		previewEntries.value = [];
		previewChannelValues.value = [];
		previewListingValues.value = {};
		inspectedId.value = null;
		previewStartDate.value = '';
		previewError.value = channels.value.length ? '' : 'Create a channel to preview XMLTV output.';
		return;
	}

	const request = ++previewSequence;
	previewBusy.value = true;
	previewError.value = '';
	try {
		const result = await api.previewGuideTemplate({
			sources: form.sources,
			channelId: previewChannelId.value,
		});
		if (request === previewSequence) {
			previewTimeZone.value = result.timeZone;
			previewStartDate.value = result.startDate;
			previewEntries.value = result.entries;
			previewChannelValues.value = result.channelValues;
			previewListingValues.value = result.listingValues;
			if (inspectedId.value && inspectedId.value !== 'channel' && !result.listingValues[inspectedId.value]) {
				inspectedId.value = null;
			}
			await nextTick();
			observePreviewZoom();
		}
	}
	catch (cause) {
		if (request === previewSequence) {
			previewError.value = errorMessage(cause);
		}
	}
	finally {
		if (request === previewSequence) {
			previewBusy.value = false;
		}
	}
}

watch(() => [form.sources, previewChannelId.value], () => {
	if (open.value) {
		schedulePreview();
	}
}, { deep: true });
watch(previewChannelId, () => {
	valuesPopover.value?.close();
});

/** Show resolved Liquid values for a preview listing or the channel identity. */
function inspectPreview(payload: { id: string; target: HTMLElement }): void {
	if (inspectedId.value === payload.id) {
		valuesPopover.value?.close();
		return;
	}

	inspectedId.value = payload.id;
	void valuesPopover.value?.show(payload.target);
}

/** Clear the inspected listing after the popover dismisses itself. */
function closeInspector(): void {
	inspectedId.value = null;
}

onMounted(() => {
	void load();
});
onUnmounted(() => {
	clearTimeout(previewTimer);
	previewZoomObserver?.disconnect();
	previewZoomObserver = null;
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
		<PageHeader title="Guide Templates" description="Control how channels and programmes appear in XMLTV.">
			<button class="button" type="button" :disabled="busy" @click="edit()"><Plus :size="20" aria-hidden="true" />New template</button>
		</PageHeader>
		<p v-if="error" class="notice error">{{ error }} <button type="button" class="button secondary" @click="load">Retry</button></p>
		<LoadingState v-if="!loaded && !error" />
		<section v-if="loaded" class="panel encoding-default-panel">
			<span class="credit-template-icon" aria-hidden="true"><FileCode :size="26" /></span>
			<div class="encoding-default-control">
				<label>
					<span>Default for XMLTV</span>
					<select :value="selectedDefault" :disabled="busy" @change="setDefault">
						<option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option>
					</select>
				</label>
				<p>Used by channels that do not choose a specific template. Changing the default updates their published XMLTV.</p>
			</div>
		</section>
		<div v-if="loaded" class="credit-template-list">
			<article v-for="template in displayTemplates" :key="template.id" class="panel credit-template-card" :class="{ 'is-default': template.isDefault }">
				<header>
					<span class="credit-template-icon" aria-hidden="true"><FileCode :size="28" /></span>
					<h2>{{ template.name }}</h2>
					<span v-if="template.isDefault" class="credit-template-badge">Default</span>
					<span v-if="template.isBuiltin" class="credit-template-badge">Built-in</span>
				</header>
				<p class="credit-template-description">{{ template.description }}</p>
				<div class="form-actions">
					<button class="button" type="button" :disabled="busy" @click="edit(template)">
						<component :is="template.isBuiltin ? Eye : Pencil" :size="19" aria-hidden="true" />{{ template.isBuiltin ? 'View' : 'Edit' }}
					</button>
					<button class="button secondary" type="button" :disabled="busy" @click="edit(template, true)">
						<Copy :size="19" aria-hidden="true" />Duplicate
					</button>
				</div>
			</article>
		</div>
		<div v-if="open" class="moirai-dialog-backdrop" @click.self="close">
			<form
				v-modal-focus="{ escape: close }"
				class="moirai-dialog resource-editor-modal guide-template-editor"
				role="dialog"
				aria-modal="true"
				aria-labelledby="guide-template-editor-title"
				@submit.prevent="save"
			>
				<ResourceEditorHeader close-label="Close guide template" :disabled="busy" @close="close">
					<div class="credit-template-title">
						<div class="resource-editor-title-with-help">
							<h2 id="guide-template-editor-title">{{ readonlyTemplate ? 'View' : id ? 'Edit' : 'New' }} Guide Template</h2>
							<PageHelpButton label="Guide templates" topic-id="playback.guide-templates" />
						</div>
						<span v-if="readonlyTemplate" class="credit-template-badge">Built-in</span>
					</div>
				</ResourceEditorHeader>
				<div class="resource-editor-scroll">
					<ResourceUsage kind="guide-template" :resource-id="id ?? undefined">
						<div class="credit-template-metadata">
							<label class="resource-primary-field">
								<span>Name</span>
								<input ref="nameInput" v-model="form.name" :disabled="busy || readonlyTemplate" required maxlength="120" />
							</label>
							<label>
								<span>Description</span>
								<input v-model="form.description" type="text" :disabled="busy || readonlyTemplate" maxlength="500" placeholder="Describe when to use this template" />
							</label>
						</div>
						<p v-if="readonlyTemplate" class="credit-template-info">
							<Info :size="22" aria-hidden="true" />
							<span>Built-in templates are read-only. Duplicate this template to customize its XMLTV layout.</span>
						</p>
						<p v-if="!readonlyTemplate && isCurrentDefault">Choose another default before deleting this template.</p>
						<div class="guide-template-source">
							<div class="guide-template-tabs" role="tablist" aria-label="XMLTV template types">
								<button
									v-for="key in GUIDE_TEMPLATE_SOURCE_KEYS"
									:key="key"
									type="button"
									role="tab"
									class="guide-template-tab"
									:aria-selected="activeTab === key"
									:tabindex="activeTab === key ? 0 : -1"
									@click="activeTab = key"
								>{{ GUIDE_TEMPLATE_TAB_LABELS[key] }}</button>
							</div>
							<label class="guide-template-source-body">
								<span class="credit-template-source-label">
									<FileCode :size="20" aria-hidden="true" />{{ GUIDE_TEMPLATE_TAB_LABELS[activeTab] }} template (Liquid)
								</span>
								<textarea
									v-model="form.sources[activeTab]"
									:readonly="readonlyTemplate"
									:disabled="busy"
									class="credit-template-source"
									:maxlength="MAX_GUIDE_TEMPLATE_SOURCE_LENGTH"
									spellcheck="false"
								/>
							</label>
						</div>
						<p class="credit-template-syntax-help">
							Use <a href="https://liquidjs.com/tutorials/intro-to-liquid.html" target="_blank" rel="noopener noreferrer">Liquid expressions and tags</a>
							to generate XMLTV <code>&lt;channel&gt;</code> and <code>&lt;programme&gt;</code> fragments.
							Text values are escaped automatically. Leave a tab completely empty to use the built-in layout for that type. A tab that still contains comments or other Liquid is used as written and does not fall back.
						</p>
						<section class="guide-template-preview">
							<h3>Preview</h3>
							<LoadingState v-if="channelsLoading" label="Loading channels…" />
							<p v-else-if="channelsError" class="notice error">
								{{ channelsError }} <button class="button secondary" type="button" @click="loadChannels">Retry channels</button>
							</p>
							<label v-if="channelsLoaded && !channelsLoading && !channelsError">
								<span>Channel</span>
								<select v-model="previewChannelId" :disabled="!channels.length">
									<option v-if="!channels.length" value="">No channels</option>
									<option v-for="channel in channels" :key="channel.id" :value="channel.id">{{ channel.number }} {{ channel.name }}</option>
								</select>
							</label>
							<div
								v-if="previewChannel"
								ref="previewFrame"
								class="guide-template-preview-frame"
								:aria-busy="previewBusy"
							>
								<GuideTimeline
									v-if="previewGuide"
									:channels="[previewChannel]"
									:guide="previewGuide"
									:time-zone="previewTimeZone"
									:start-date="previewStartDate"
									:days="1"
									:hour-width="previewHourWidth"
									use-entry-titles
									subtitle-mode="listing"
									inspect-listings
									empty-message="No programming for this day"
									@inspect="inspectPreview"
								/>
								<GuideTemplateValuesPopover
									ref="valuesPopover"
									:title="inspectedLabel"
									:values="inspectedValues"
									@close="closeInspector"
								/>
								<div v-if="previewBusy || previewError" class="guide-template-preview-overlay">
									<div v-if="previewBusy" class="guide-template-preview-refresh" role="status">
										<span class="loading-spinner" aria-hidden="true"></span>
										<span>Refreshing listings…</span>
									</div>
									<p v-else class="notice error">{{ previewError }}</p>
								</div>
							</div>
							<p v-else-if="channelsLoaded && !channelsLoading && !channelsError">Create a channel to preview one local day.</p>
						</section>
						<p v-if="editorError" class="notice error">{{ editorError }}</p>
					</ResourceUsage>
				</div>
				<ResourceEditorActionBar
					v-if="!readonlyTemplate"
					resource-type="Guide Template"
					:show-delete="Boolean(id) && !isCurrentDefault"
					:busy="busy"
					:saving="busy"
					:reset-disabled="!dirty"
					:save-disabled="!valid || (Boolean(id) && !dirty)"
					save-submits
					@reset="resetDraft"
					@delete="remove"
				/>
				<footer v-if="readonlyTemplate" class="resource-editor-action-bar credit-template-view-actions">
					<button class="button secondary" type="button" @click="close">Close</button>
					<button class="button secondary" type="button" @click="duplicateViewedTemplate"><Copy :size="20" aria-hidden="true" />Duplicate</button>
				</footer>
			</form>
		</div>
	</div>
</template>
