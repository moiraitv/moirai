<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import { ArrowDown, ArrowUp, Clock3, Copy, Eye, Image, Minus, Pencil, Plus, Shapes, Tv, Type, Upload } from '@lucide/vue';
import { emptyGraphicsContext, graphicsDraftSchema, graphicsExampleIds, MAX_GRAPHICS_LAYERS, MAX_GRAPHICS_LAYER_NAME_LENGTH, type Channel, type GraphicsAsset, type GraphicsLayer, type GraphicsPreset, type GraphicsPreviewContext } from '@moirai/shared';
import { isMap, isSeq } from 'yaml';
import { ApiError, api, request } from '../api';
import { randomUuid } from '../random-uuid';
import { errorMessage } from '../error-message';
import { requestConfirmation, requestUnsavedChanges } from '../confirmation';
import { patchGraphicsYaml, readGraphicsDraft } from '../graphics-draft';
import { channelLogoUrl } from '../channel-logo';
import GraphicsPicker from '../components/graphics/GraphicsPicker.vue';
import GraphicsSample from '../components/graphics/GraphicsSample.vue';
import GraphicsCanvas from '../components/graphics/GraphicsCanvas.vue';
import GraphicsLayerAddMenu from '../components/graphics/GraphicsLayerAddMenu.vue';
import GraphicsLayerInspector from '../components/graphics/GraphicsLayerInspector.vue';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import ResourceEditorHeader from '../components/ResourceEditorHeader.vue';
import ResourceEditorActionBar from '../components/ResourceEditorActionBar.vue';
import TwoStepActionButton from '../components/TwoStepActionButton.vue';

/** Summaries of the techniques illustrated by the protected presets. */
const exampleDescriptions = new Map<string, string>([
	[graphicsExampleIds[0], 'A translucent logo anchored in a corner.'],
	[graphicsExampleIds[1], 'A styled lower third with programme titles and a timed fade.'],
	[graphicsExampleIds[2], 'The channel name appears periodically on the broadcast clock.'],
	[graphicsExampleIds[3], 'A looping animation over the picture.'],
	[graphicsExampleIds[4], 'A live clock in the broadcast time zone.'],
	[graphicsExampleIds[5], 'Start times and titles for the next two programmes.'],
]);

const route = useRoute();
const router = useRouter();
const presets = ref<GraphicsPreset[]>([]);
const cards = computed(() => presets.value.map(preset => {
	const layers = readGraphicsDraft(preset.yaml).data?.layers ?? [];
	const timed = layers.find(layer => layer.timing.mode === 'once' || (layer.timing.mode === 'periodic' && layer.timing.clock === 'content'))?.timing;
	const elapsedMs = timed && timed.mode !== 'always' ? timed.phase + timed.fade + timed.hold / 2 : 5000;
	return { preset, layers, elapsedMs };
}));
const assets = ref<GraphicsAsset[]>([]);
const channels = ref<Channel[]>([]);
const loaded = ref(false);
const loadingError = ref('');
const error = ref('');
const busy = ref(false);
const saving = ref(false);
const name = ref('');
const source = ref('');
const mode = ref<'visual' | 'yaml'>('visual');
const baseline = ref({ name: '', source: '' });
const selected = ref('');
const layerList = ref<HTMLElement>();
const previewChannel = ref('');
const assetInput = ref<HTMLInputElement>();
const previewChannels = computed(() => [{ id: '', name: 'Sample channel', number: '', logo: null },
	...channels.value.map(channel => ({ id: channel.id, name: channel.name, number: channel.number, logo: channelLogoUrl(channel) }))]);
const showWallClockLayers = ref(true);
const selectedChannel = computed(() => channels.value.find(channel => channel.id === previewChannel.value));
const previewMetadata = ref<GraphicsPreviewContext>();
const previewMetadataLoading = ref(false);
const canvasContext = computed(() => previewMetadata.value?.context
	?? (selectedChannel.value ? emptyGraphicsContext(selectedChannel.value) : undefined));
const elapsed = ref(5000);
const frame = ref('');
const previewButton = ref<HTMLButtonElement>();
const previewProgress = ref<'generating' | 'retrying'>();
const previewError = ref('');
const previewWarning = ref('');
const active = computed(() => presets.value.find(preset => preset.id === route.params.id));
const editing = computed(() => Boolean(route.params.id) && loaded.value);
/** Fetch labels immediately for a new channel and after a pause when scrubbing. */
watch(
	() => [editing.value && mode.value === 'visual' ? previewChannel.value : '', elapsed.value] as const,
	([channelId, elapsedMs], previous, onCleanup) => {
		previewMetadata.value = undefined;
		previewMetadataLoading.value = Boolean(channelId);
		if (!channelId) {
			return;
		}

		const controller = new AbortController();
		const query = new URLSearchParams({ channelId, elapsedMs: String(elapsedMs) });
		const load = async (): Promise<void> => {
			try {
				const response = await request<GraphicsPreviewContext>(`/api/v1/graphics/preview-context?${query}`, { signal: controller.signal });
				if (!controller.signal.aborted) {
					previewMetadata.value = response;
				}
			}
			catch {
				// Keep the actual channel identity while the selected position is unavailable.
			}
			finally {
				if (!controller.signal.aborted) {
					previewMetadataLoading.value = false;
				}
			}
		};
		const timer = previous?.[0] === channelId ? window.setTimeout(() => void load(), 150) : undefined;
		onCleanup(() => {
			window.clearTimeout(timer);
			controller.abort();
		});
		if (timer === undefined) {
			void load();
		}
	},
);

const monitorStatus = computed(() => {
	if (frame.value) {
		return 'Rendered frame';
	}
	if (!previewChannel.value) {
		return 'Sample layout';
	}
	if (previewMetadataLoading.value) {
		return 'Loading schedule';
	}
	switch (previewMetadata.value?.availability) {
		case 'available': return 'Channel layout';
		case 'gap': return 'Schedule gap';
		default: return 'Schedule data unavailable';
	}
});
const newPreset = computed(() => route.params.id === 'new');
const protectedPreset = computed(() => Boolean(active.value?.protected));
const dirty = computed(() => !protectedPreset.value && (name.value !== baseline.value.name || source.value !== baseline.value.source));
const draft = computed(() => readGraphicsDraft(source.value));
const layers = computed(() => draft.value.data?.layers ?? []);
/** Present the layer stack front to back while the draft stays in draw order. */
const layerStack = computed(() => layers.value.slice().reverse());
const hasWallClockLayers = computed(() => layers.value.some(layer => layer.timing.mode === 'periodic' && layer.timing.clock === 'wall'));
const previewLimit = computed(() => Math.min(86_400_000, layers.value.reduce((limit, layer) => {
	const timing = layer.timing;
	if (timing.mode === 'always') {
		return limit;
	}
	return Math.max(limit, timing.mode === 'once' ? timing.phase + timing.hold + 2 * timing.fade : timing.phase + timing.frequency);
}, 60_000)));
const currentLayer = computed(() => layers.value.find(layer => layer.id === selected.value) ?? layerStack.value[0]);
const currentLayerIndex = computed(() => layers.value.findIndex(layer => layer.id === currentLayer.value?.id));
const currentStackIndex = computed(() => layerStack.value.findIndex(layer => layer.id === currentLayer.value?.id));
const layerLimitReached = computed(() => layers.value.length >= MAX_GRAPHICS_LAYERS);
const canRemoveLayer = computed(() => Boolean(currentLayer.value) && !layers.value.some(layer => layer.attachment?.layerId === currentLayer.value?.id));
const valid = computed(() => Boolean(draft.value.data) && graphicsDraftSchema.safeParse({ name: name.value, yaml: source.value }).success
	&& layers.value.every(layer => layer.kind === 'media' ? assets.value.some(asset => asset.id === layer.assetId && asset.kind !== 'font')
		: layer.kind !== 'text' || [layer.style, ...Object.values(layer.styles ?? {})].every(style => !style.fontId || assets.value.some(asset => asset.id === style.fontId && asset.kind === 'font'))));
let previewRequest: AbortController | undefined;
let opener: HTMLElement | null = null;

/** Load collections before resolving the route or claiming that the workspace is empty. */
async function load(): Promise<void> {
	loadingError.value = '';
	try {
		[presets.value, assets.value, channels.value] = await Promise.all([
			api.graphicsPresets(), request<GraphicsAsset[]>('/api/v1/graphics/assets'), api.channels(),
		]);
		loaded.value = true;
		openRoute();
	}
	catch (cause) {
		loadingError.value = errorMessage(cause);
	}
}

/** Adopt the saved preset or initialize a new or duplicated draft. */
function openRoute(): void {
	clearFrame();
	error.value = '';
	mode.value = 'visual';
	elapsed.value = 5000;
	showWallClockLayers.value = true;
	selected.value = '';
	const duplicate = presets.value.find(preset => preset.id === route.query.duplicate);
	name.value = active.value?.name ?? (duplicate ? `${duplicate.name.slice(0, 113)} copy` : '');
	source.value = active.value?.yaml ?? duplicate?.yaml ?? 'version: 1\nlayers: []\n';
	baseline.value = { name: name.value, source: source.value };
	if (protectedPreset.value) {
		void renderFrame();
	}
}

/** Use the same save/discard prompt for close, Escape, backdrop, and navigation. */
async function confirmClose(): Promise<boolean> {
	if (busy.value) {
		return false;
	}
	if (!dirty.value) {
		return true;
	}
	const answer = await requestUnsavedChanges({ key: 'graphics-preset', message: 'Save changes to this graphics preset?' });
	if (answer === 'save') {
		return await save(false);
	}
	return answer === 'discard';
}

/** Close the route-backed editor and restore focus to the opening control. */
async function close(): Promise<void> {
	await router.push('/graphics');
	if (!route.params.id) {
		await nextTick();
		opener?.focus();
	}
}

/** Open an editor from a collection control. */
function openEditor(id: string, duplicate?: string): void {
	opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	void router.push({ path: `/graphics/${id}`, query: duplicate ? { duplicate } : {} });
}

/** Save the exact YAML draft and adopt the persisted identity. */
async function save(adopt = true): Promise<boolean> {
	if (!valid.value || busy.value || protectedPreset.value) {
		return false;
	}
	busy.value = true;
	saving.value = true;
	error.value = '';
	try {
		const id = active.value?.id;
		const saved = await request<GraphicsPreset>(`/api/v1/graphics/presets${id ? `/${id}` : ''}`, {
			method: id ? 'PUT' : 'POST', body: JSON.stringify({ name: name.value, yaml: source.value }),
		});
		presets.value = [...presets.value.filter(preset => preset.id !== saved.id), saved]
			.sort((left, right) => Number(right.protected) - Number(left.protected) || (!left.protected ? left.name.localeCompare(right.name) : 0));
		name.value = saved.name;
		baseline.value = { name: saved.name, source: saved.yaml };
		busy.value = false;
		if (adopt && !id) {
			await router.replace(`/graphics/${saved.id}`);
		}
		return true;
	}
	catch (cause) {
		error.value = errorMessage(cause);
		return false;
	}
	finally {
		saving.value = false;
		busy.value = false;
	}
}

/** Confirm permanent deletion and let the server enforce references. */
async function remove(): Promise<void> {
	const preset = active.value;
	if (!preset || !(await requestConfirmation({
		title: 'Delete graphics preset?', message: `Delete ${preset.name} and discard unsaved changes?`,
		confirmLabel: 'Delete Graphics Preset', destructive: true,
	}))) {
		return;
	}
	busy.value = true;
	try {
		await request(`/api/v1/graphics/presets/${preset.id}`, { method: 'DELETE' });
		presets.value = presets.value.filter(item => item.id !== preset.id);
		baseline.value = { name: name.value, source: source.value };
		busy.value = false;
		await close();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		busy.value = false;
	}
}

/** Restore the captured preset after the action bar's two-step reset. */
function reset(): void {
	name.value = baseline.value.name;
	source.value = baseline.value.source;
	clearFrame();
}

/** Release the current image before replacing it or returning to the editable canvas. */
function releaseFrame(): void {
	if (frame.value) {
		URL.revokeObjectURL(frame.value);
		frame.value = '';
	}
}

/** Cancel pending work when the draft or preview position changes. */
function clearFrame(): void {
	previewRequest?.abort();
	previewRequest = undefined;
	previewProgress.value = undefined;
	previewError.value = '';
	previewWarning.value = '';
	releaseFrame();
}

/** Return keyboard focus to the preview action when the Edit button becomes hidden. */
async function editFrame(): Promise<void> {
	clearFrame();
	await nextTick();
	previewButton.value?.focus({ preventScroll: true });
}

/** Wait briefly for the isolated render slot, ending the wait on a draft change. */
function waitForPreviewRetry(signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const timer = window.setTimeout(resolve, 1000);
		signal.addEventListener('abort', () => {
			window.clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}

/** Render the same draft once more if the isolated preview slot was occupied. */
async function renderFrame(): Promise<void> {
	if (!draft.value.data || previewRequest) {
		return;
	}
	const controller = new AbortController();
	previewRequest = controller;
	previewProgress.value = 'generating';
	previewError.value = '';
	previewWarning.value = '';
	const body = JSON.stringify({
		yaml: source.value, channelId: previewChannel.value || undefined, elapsedMs: elapsed.value,
		...(hasWallClockLayers.value ? { showWallClockLayers: showWallClockLayers.value } : {}),
	});
	const render = () => request('/api/v1/graphics/preview', {
		method: 'POST', body, signal: controller.signal,
	}, async response => ({ image: await response.blob(), warning: response.headers.get('X-Moirai-Graphics-Warning') }));
	try {
		const { image, warning } = await render().catch(async cause => {
			if (controller.signal.aborted || !(cause instanceof ApiError) || cause.body.code !== 'graphics_preview_busy') {
				throw cause;
			}

			previewProgress.value = 'retrying';
			await waitForPreviewRetry(controller.signal);
			controller.signal.throwIfAborted();
			return render();
		});
		if (previewRequest === controller) {
			releaseFrame();
			frame.value = URL.createObjectURL(image);
			previewWarning.value = warning ?? '';
		}
	}
	catch (cause) {
		if (previewRequest === controller) {
			previewError.value = cause instanceof ApiError
				? errorMessage(cause)
				: 'Could not load the preview. Check your connection and retry.';
		}
	}
	finally {
		if (previewRequest === controller) {
			previewRequest = undefined;
			previewProgress.value = undefined;
		}
	}
}

/** Apply a YAML tree change while preserving unaffected nodes and comments. */
function updateSource(value: string): void {
	source.value = value;
	clearFrame();
}

/** Update layer properties in place so neighboring YAML comments survive visual edits. */
function patchLayer(changes: Record<string, unknown>, id = currentLayer.value?.id): void {
	const yaml = draft.value.yaml;
	const index = layers.value.findIndex(layer => layer.id === id);
	if (!yaml || index < 0) {
		return;
	}
	for (const [key, value] of Object.entries(changes)) {
		patchGraphicsYaml(yaml, ['layers', index, key], value);
	}
	updateSource(yaml.toString());
}

/** Insert a valid starter layer and select it for editing. */
function addLayer(kind: GraphicsLayer['kind']): void {
	const yaml = draft.value.yaml;
	const asset = assets.value.find(item => item.kind !== 'font');
	if (!yaml || layerLimitReached.value || (kind === 'media' && !asset)) {
		return;
	}
	const id = randomUuid();
	const defaults = { id, anchor: 'bottom_left', horizontalMargin: 5, verticalMargin: 5, opacity: 100, withinSource: false, timing: { mode: 'always' } };
	yaml.addIn(['layers'], kind === 'text' ? { ...defaults, kind, text: 'Now Playing: {{ now.title }}', style: { size: 48, color: '#FFFFFF' } }
		: kind === 'shape' ? { ...defaults, kind, width: 30, shape: { primitive: 'roundedRectangle', width: 576, height: 120, fill: '#103C36', stroke: '#FFFFFF', strokeWidth: 0, radius: 16 } }
			: kind === 'clock' ? { ...defaults, kind, anchor: 'top_right', width: 20, badge: { color: '#FFFFFF', background: '#0B1F35', backgroundOpacity: 90 } }
				: { ...defaults, kind, assetId: asset!.id, width: 15 });
	updateSource(yaml.toString());
	selected.value = id;
}

/** Copy the selected layer directly above the original, with its own stable identity. */
function duplicateLayer(): void {
	const yaml = draft.value.yaml?.clone();
	const sequence = yaml?.get('layers', true);
	const index = currentLayerIndex.value;
	const original = isSeq(sequence) ? sequence.items[index] : undefined;
	if (!yaml || !isSeq(sequence) || !isMap(original) || layerLimitReached.value) {
		return;
	}

	const copy = original.clone();
	const id = randomUuid();
	const name = currentLayer.value?.name;
	copy.set('id', id);
	if (name) {
		copy.set('name', `${name.slice(0, MAX_GRAPHICS_LAYER_NAME_LENGTH - 5).trimEnd()} copy`);
	}
	sequence.items.splice(index + 1, 0, copy);
	const source = yaml.toString();
	const duplicated = readGraphicsDraft(source);
	if (!duplicated.data) {
		error.value = duplicated.error;
		return;
	}
	error.value = '';
	updateSource(source);
	selected.value = id;
}

/** Move a YAML sequence node without recreating it, or remove the selected node. */
function rearrange(offset?: number): void {
	const yaml = draft.value.yaml;
	const sequence = yaml?.get('layers', true);
	const index = currentLayerIndex.value;
	if (!yaml || !isSeq(sequence) || index < 0 || (offset !== undefined && !layers.value[index + offset])
		|| (offset === undefined && !canRemoveLayer.value)) {
		return;
	}
	const [node] = sequence.items.splice(index, 1);
	if (offset !== undefined) {
		sequence.items.splice(index + offset, 0, node);
	}
	updateSource(yaml.toString());
}

/** Store a validated asset and apply inline media uploads to the originating layer. */
async function upload(event: Event, layerId?: string): Promise<void> {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	if (!file) {
		return;
	}
	busy.value = true;
	error.value = '';
	try {
		const body = new FormData();
		body.append('file', file);
		const asset = await request<GraphicsAsset>('/api/v1/graphics/assets', { method: 'POST', body });
		assets.value.push(asset);
		if (layerId && asset.kind !== 'font') {
			patchLayer({ assetId: asset.id }, layerId);
		}
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		input.value = '';
		busy.value = false;
	}
}

/** Confirm retirement and retain any reference conflict in the editor. */
async function removeAsset(asset: GraphicsAsset): Promise<void> {
	if (!(await requestConfirmation({ title: 'Delete graphics asset?', message: `Remove ${asset.name} from the asset library?`, confirmLabel: 'Delete Asset', destructive: true }))) {
		return;
	}
	try {
		await request(`/api/v1/graphics/assets/${asset.id}`, { method: 'DELETE' });
		assets.value = assets.value.filter(item => item.id !== asset.id);
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

onMounted(load);
onBeforeUnmount(clearFrame);
onBeforeRouteLeave(confirmClose);
onBeforeRouteUpdate(to => (to.params.id === route.params.id && to.query.duplicate === route.query.duplicate) || confirmClose());
watch(() => [route.params.id, route.query.duplicate], openRoute);
watch(mode, value => {
	if (value === 'yaml') {
		clearFrame();
	}
}, { flush: 'sync' });
watch(name, () => {
	if (previewRequest) {
		clearFrame();
	}
}, { flush: 'sync' });
watch([layerList, currentStackIndex, () => currentLayer.value?.id], ([list, index]) => {
	const row = list?.children[index];
	if (list && row) {
		const viewport = list.getBoundingClientRect();
		const bounds = row.getBoundingClientRect();
		if (bounds.top < viewport.top) {
			list.scrollTop += bounds.top - viewport.top;
		}
		else if (bounds.bottom > viewport.bottom) {
			list.scrollTop += bounds.bottom - viewport.bottom;
		}
	}
}, { flush: 'post' });
</script>

<template>
	<div>
		<PageHeader title="Graphics" description="Design reusable channel watermarks, animated overlays, and programme graphics. Each preset is shown on the sample channel.">
			<button type="button" class="button" :disabled="!loaded" @click="openEditor('new')"><Plus :size="20" /> New Graphics Preset</button>
		</PageHeader>
		<LoadingState v-if="!loaded && !loadingError" label="Loading graphics presets…" />
		<p v-if="loadingError" class="notice error" role="alert">{{ loadingError }} <button type="button" @click="load">Retry</button></p>
		<div v-if="loaded" class="graphics-gallery">
			<article v-for="{ preset, layers: cardLayers, elapsedMs } in cards" :key="preset.id" class="panel graphics-preset-card">
				<GraphicsSample :key="preset.yaml" :preset-id="preset.id" :layers="cardLayers" :assets="assets" :elapsed-ms="elapsedMs" :enabled="!editing" />
				<div class="graphics-preset-copy">
					<header><h2>{{ preset.name }}</h2><span v-if="preset.protected" class="encoding-profile-badge builtin-badge">Example</span></header>
					<p>{{ exampleDescriptions.get(preset.id) ?? (cardLayers.length === 1 ? '1 layer' : `${cardLayers.length} layers`) }}</p>
				</div>
				<div class="graphics-preset-actions">
					<button type="button" class="button secondary" @click="openEditor(preset.id)"><component :is="preset.protected ? Eye : Pencil" :size="18" aria-hidden="true" />{{ preset.protected ? 'Preview' : 'Edit' }}</button>
					<button type="button" class="button secondary" @click="openEditor('new', preset.id)"><Copy :size="18" aria-hidden="true" />Duplicate</button>
				</div>
			</article>
		</div>
		<div v-if="editing" class="moirai-dialog-backdrop" @click.self="close">
			<form v-modal-focus="{ escape: close }" class="moirai-dialog resource-editor-modal graphics-editor" role="dialog" aria-modal="true" aria-labelledby="graphics-editor-title" @submit.prevent="save()">
				<ResourceEditorHeader close-label="Close graphics preset" :disabled="busy" @close="close">
					<h2 id="graphics-editor-title" :class="{ 'sr-only': !protectedPreset && (active || route.params.id === 'new') }">{{ name.trim() || 'New Graphics Preset' }}</h2>
					<label v-if="!protectedPreset && (active || route.params.id === 'new')" class="graphics-title-field">
						<Pencil :size="16" aria-hidden="true" />
						<input v-model="name" class="graphics-title-input" type="text" aria-label="Name" placeholder="New Graphics Preset" maxlength="120" required :disabled="busy" />
					</label>
					<template v-if="active || route.params.id === 'new'" #actions>
						<div class="graphics-mode" role="group" aria-label="Editing mode">
							<button type="button" :aria-pressed="mode === 'visual'" :disabled="busy || !draft.data" @click="mode = 'visual'">Visual</button>
							<button type="button" :aria-pressed="mode === 'yaml'" :disabled="busy" @click="mode = 'yaml'">YAML</button>
						</div>
					</template>
				</ResourceEditorHeader>
				<div class="resource-editor-scroll graphics-editor-body" :class="{ 'graphics-visual': mode === 'visual' && (active || route.params.id === 'new') }" :inert="busy">
					<p v-if="!active && route.params.id !== 'new'" class="notice error" role="alert">Graphics preset not found.</p>
					<template v-else>
						<section v-if="mode === 'visual'" class="graphics-preview-panel" aria-labelledby="graphics-preview-heading">
							<div class="graphics-panel-heading">
								<h3 id="graphics-preview-heading">Preview</h3>
								<span class="graphics-monitor-status" role="status">{{ monitorStatus }}</span>
								<span class="graphics-monitor-ratio">16:9</span>
							</div>
							<div class="graphics-monitor">
								<GraphicsCanvas
									:layers="layers" :assets="assets" :selected="currentLayer?.id ?? ''" :disabled="protectedPreset" :elapsed-ms="elapsed" :frame="frame" :context="canvasContext"
									@select="selected = $event" @patch="(id, changes) => patchLayer(changes, id)">
									<div class="graphics-preview-progress" role="status">
										<span v-if="previewProgress" class="graphics-preview-progress-badge">
											<span class="loading-spinner" aria-hidden="true"></span>
											{{ previewProgress === 'retrying' ? 'Retrying preview…' : 'Generating preview…' }}
										</span>
									</div>
									<div
										v-if="previewError || previewWarning" class="graphics-preview-feedback"
										:class="{ 'graphics-preview-feedback-error': previewError }" tabindex="0"
										:role="previewError ? 'alert' : 'status'">{{ previewError || previewWarning }}</div>
								</GraphicsCanvas>
							</div>
							<div class="graphics-preview-controls">
								<div class="graphics-preview-fields">
									<label class="graphics-scrubber"><span>Elapsed time ({{ (elapsed / 1000).toFixed(1) }} s)</span><input v-model.number="elapsed" type="range" min="0" :max="previewLimit" step="100" @input="clearFrame" /></label>
									<GraphicsPicker v-model="previewChannel" label="Preview channel" :options="previewChannels" @update:model-value="clearFrame">
										<template #default="{ option }">
											<span class="graphics-picker-thumbnail" aria-hidden="true">
												<img v-if="option.logo" :src="option.logo" alt="" loading="lazy" />
												<Tv v-else :size="17" />
											</span>
											<span v-if="option.number" class="graphics-picker-number">{{ option.number }}</span>
											<span class="graphics-picker-name">{{ option.name }}</span>
										</template>
									</GraphicsPicker>
								</div>
								<div class="graphics-preview-actions">
									<button ref="previewButton" type="button" class="button secondary graphics-preview-trigger" :disabled="Boolean(previewProgress) || !draft.data" @click="renderFrame">{{ previewError ? 'Retry' : 'Preview' }}</button>
									<button
										type="button" class="button secondary" :class="{ 'graphics-preview-edit-hidden': !frame }"
										:disabled="!frame" @click="editFrame">Edit</button>
								</div>
							</div>
							<label v-if="hasWallClockLayers" class="graphics-preview-timing">
								<input v-model="showWallClockLayers" type="checkbox" @change="clearFrame" />
								<span>Show wall-clock layers outside their scheduled times</span>
							</label>
						</section>
						<div class="graphics-parameters" role="region" aria-label="Preset parameters" tabindex="0">
							<label v-if="mode === 'yaml'"><span>Graphics YAML</span><textarea class="graphics-yaml" :value="source" maxlength="32768" rows="16" spellcheck="false" :readonly="protectedPreset" @input="updateSource(($event.target as HTMLTextAreaElement).value)" /></label>
							<section v-else class="graphics-layer-panel" aria-labelledby="graphics-layers-heading">
								<h3 id="graphics-layers-heading">Layers</h3>
								<div class="graphics-layer-stack">
									<div ref="layerList" class="graphics-layer-list" role="region" aria-label="Layer list">
										<p v-if="!layers.length" class="graphics-empty-layers">Use + to add your first layer.</p>
										<button v-for="(layer, index) in layerStack" :key="layer.id" type="button" class="graphics-layer-row" :aria-pressed="layer.id === currentLayer?.id" @click="selected = layer.id">
											<span class="graphics-layer-icon" :data-kind="layer.kind"><component :is="layer.kind === 'text' ? Type : layer.kind === 'shape' ? Shapes : layer.kind === 'clock' ? Clock3 : Image" :size="18" aria-hidden="true" /></span>
											<span class="graphics-layer-copy">
												<strong>{{ index + 1 }}. {{ layer.name ?? (layer.kind === 'text' ? 'Text' : layer.kind === 'shape' ? 'Shape' : layer.kind === 'clock' ? 'Clock' : assets.find(asset => asset.id === layer.assetId)?.name ?? 'Missing media') }}</strong>
												<small aria-hidden="true">{{ layer.kind === 'text' ? (layer.text.includes('{{') ? 'Liquid template' : 'Styled text') : layer.kind === 'shape' ? 'Vector shape' : layer.kind === 'clock' ? 'Broadcast time' : 'Managed media' }}</small>
											</span>
										</button>
									</div>
									<div class="graphics-layer-tools" role="group" aria-label="Layer actions">
										<GraphicsLayerAddMenu :disabled="protectedPreset || layerLimitReached" @add="addLayer" />
										<TwoStepActionButton :key="currentLayer?.id ?? ''" class="button graphics-layer-tool" label="Remove layer" confirm-label="Confirm remove layer" :disabled="protectedPreset || !canRemoveLayer" @confirm="rearrange()"><Minus :size="17" aria-hidden="true" /></TwoStepActionButton>
										<button type="button" class="button graphics-layer-tool" aria-label="Duplicate layer" title="Duplicate layer" :disabled="protectedPreset || !currentLayer || layerLimitReached" @click="duplicateLayer"><Copy :size="16" aria-hidden="true" /></button>
									</div>
								</div>
								<div v-if="!protectedPreset" class="graphics-layer-actions graphics-reorder-actions" role="group" aria-label="Reorder layers">
									<button type="button" class="button secondary" :disabled="!currentLayer || currentLayer === layers[0]" @click="rearrange(-1)"><ArrowDown :size="16" aria-hidden="true" /> Move lower</button>
									<button type="button" class="button secondary" :disabled="!currentLayer || currentLayer === layers.at(-1)" @click="rearrange(1)"><ArrowUp :size="16" aria-hidden="true" /> Move higher</button>
								</div>
								<div v-if="currentLayer" :key="currentLayer.id" class="graphics-layer-settings-scroll" role="region" aria-label="Layer settings" tabindex="0">
									<GraphicsLayerInspector :layer="currentLayer" :layers="layerStack" :assets="assets" :disabled="protectedPreset" @patch="patchLayer($event)" @upload-media="upload" />
								</div>
							</section>
							<p v-if="draft.error" class="notice error" role="alert">{{ draft.error }}</p>
							<p v-else-if="!valid && name.trim()" class="notice error" role="alert">Check the referenced media and fonts.</p>
							<details v-if="!protectedPreset" class="graphics-assets">
								<summary>Manage assets</summary>
								<div class="channel-logo-picker graphics-asset-upload">
									<span class="channel-logo-current" aria-hidden="true"><Image :size="30" /></span>
									<div>
										<input ref="assetInput" type="file" accept=".png,.apng,.jpeg,.jpg,.gif,.webp,.webm,.mp4,.ttf,.otf" hidden @change="upload" />
										<button type="button" class="button secondary" @click="assetInput?.click()"><Upload :size="16" aria-hidden="true" /> Choose File</button>
										<p>Upload an image, looping video, or font for use in graphics presets.</p>
									</div>
								</div>
								<ul><li v-for="asset in assets" :key="asset.id">{{ asset.name }} <button v-if="!asset.protected" type="button" class="button secondary" @click="removeAsset(asset)">Delete</button></li></ul>
							</details>
							<p v-if="error" class="notice error" role="alert">{{ error }}</p>
						</div>
					</template>
				</div>
				<ResourceEditorActionBar v-if="!protectedPreset && (active || route.params.id === 'new')" :pending="dirty || newPreset" resource-type="Graphics Preset" :show-delete="Boolean(active)" :busy="busy" :saving="saving" :reset-disabled="!dirty" :save-disabled="!valid || (!newPreset && !dirty)" save-submits @close="close" @reset="reset" @delete="remove" />
				<footer v-else class="resource-editor-action-bar"><button v-if="active" type="button" class="button secondary" @click="openEditor('new', active.id)"><Copy :size="18" /> Duplicate</button></footer>
			</form>
		</div>
	</div>
</template>
