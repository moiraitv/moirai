<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { RouterLink } from 'vue-router';
import {
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	Clock3,
	Pencil,
	Plus,
	ImagePlus,
	Trash2,
	Upload,
	X,
} from '@lucide/vue';
import {
	CHANNEL_LOGO_MAX_BYTES,
	CHANNEL_LOGO_MAX_DIMENSION,
	managedChannelLogoId,
	type Channel,
	type ChannelCreate,
} from '@moirai/shared';
import type { HardwareAccelerationPrediction } from '@moirai/shared/api-contracts';
import { api } from '../api';
import { formatHardwareAccelerationPrediction } from '../channel-acceleration';
import { channelLogoUrl } from '../channel-logo';
import { dateKey, formatDateKey, shiftDateKey } from '../date-key';
import { errorMessage } from '../error-message';
import GuideTimeline from '../components/GuideTimeline.vue';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import { liveEvents } from '../live-events';
import { affectsGuide } from '../guide-events';
import { cloneContractValue } from '../reactive-clone';
import { useChannelsStore } from '../stores/channels';
import { useSchedulingStore } from '../stores/scheduling';

const channelsStore = useChannelsStore();
const {
	channels,
	guide,
	timeZone,
	guideWeekStart: weekStart,
	guideDays,
	loaded: channelsLoaded,
	capabilitiesLoaded,
	guideLoaded,
} = storeToRefs(channelsStore);
const initialLoading = ref(
	!(channelsLoaded.value && capabilitiesLoaded.value && guideLoaded.value && guideDays.value >= 7),
);
const scheduling = useSchedulingStore();
const editingId = ref<string>();
const showForm = ref(false);
const error = ref('');
const logoInput = ref<HTMLInputElement>();
const externalLogoUrl = ref('');
const removeLogoOnSave = ref(false);
const saving = ref(false);
const accelerationPrediction = ref<HardwareAccelerationPrediction>();
const accelerationPredictionLoading = ref(false);
let liveRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let accelerationPredictionTimer: ReturnType<typeof setTimeout> | undefined;
let accelerationPredictionSequence = 0;
let suppressChannelEventsUntil = 0;
/** Channel guide row with layout metadata derived for the visible window. */
type CropInteraction = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
const cropHandles: CropInteraction[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const logoCrop = reactive({ x: 0, y: 0, width: 1, height: 1 });
const logoDrag = reactive({
	active: false,
	mode: 'move' as CropInteraction,
	pointerX: 0,
	pointerY: 0,
	cropX: 0,
	cropY: 0,
	cropWidth: 1,
	cropHeight: 1,
});
const cropSource = shallowRef<{
	url: string;
	image: HTMLImageElement;
	width: number;
	height: number;
}>();
const LOGO_CROP_MAX_WIDTH = 240;
const LOGO_CROP_MAX_HEIGHT = 260;
const LOGO_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
const LOGO_SOURCE_MAX_PIXELS = 64_000_000;
const defaults = (): ChannelCreate => ({
	number: '',
	name: '',
	logo: null,
	group: null,
	audio: {
		format: 'aac',
		bitrateKbps: 192,
		bufferKbps: 384,
		channels: 2,
		sampleRateHz: 48000,
		normalizeLoudness: true,
		loudness: { integratedTarget: -16, rangeTarget: 11, truePeak: -1.5 },
	},
	video: {
		format: 'h264',
		bitDepth: 8,
		width: 1920,
		height: 1080,
		scalingMode: 'scale_and_pad',
		bitrateKbps: 2000,
		bufferKbps: 4000,
		accel: 'automatic',
		vaapiDevice: null,
		vaapiDriver: null,
		deinterlace: false,
	},
	subtitleMode: 'burn',
	ffmpegPath: null,
	ffprobePath: null,
	disabledFilters: [],
	preferredFilters: [],
});
const form = reactive<ChannelCreate>(defaults());
/** Compact status displayed beneath the Automatic option without changing modal flow. */
const accelerationPredictionText = computed(() => formatHardwareAccelerationPrediction(
	accelerationPrediction.value,
	accelerationPredictionLoading.value,
));
const scheduleByChannel = computed(
	() =>
		new Map(
			(scheduling.overview?.channelSchedules ?? []).map((schedule) => [
				schedule.channelId,
				schedule,
			]),
		),
);

const cropDisplayScale = computed(() => {
	const source = cropSource.value;
	if (!source) {
		return 1;
	}

	return Math.min(LOGO_CROP_MAX_WIDTH / source.width, LOGO_CROP_MAX_HEIGHT / source.height);
});

const cropStageStyle = computed(() => {
	const source = cropSource.value;
	if (!source) {
		return {};
	}

	return {
		width: `${source.width * cropDisplayScale.value}px`,
		height: `${source.height * cropDisplayScale.value}px`,
	};
});

const cropSelectionStyle = computed(() => {
	const scale = cropDisplayScale.value;
	return {
		left: `${logoCrop.x * scale}px`,
		top: `${logoCrop.y * scale}px`,
		width: `${logoCrop.width * scale}px`,
		height: `${logoCrop.height * scale}px`,
	};
});

const configuredLogoLimit = computed(() => {
	const width = Math.min(form.video.width ?? 0, CHANNEL_LOGO_MAX_DIMENSION);
	const height = Math.min(form.video.height ?? 0, CHANNEL_LOGO_MAX_DIMENSION);
	return width && height ? `${width}×${height}` : 'resolution required';
});

/** Resolve the logo preview after applying the current edit form's keep-or-remove choice. */
function existingLogoUrl(): string | null {
	if (removeLogoOnSave.value) {
		return null;
	}

	const managedId = managedChannelLogoId(form.logo);
	if (managedId) {
		const channel = channels.value.find((candidate) => candidate.id === editingId.value);
		return channel ? channelLogoUrl(channel) : null;
	}

	return externalLogoUrl.value.trim() || null;
}

/** Revoke the temporary image URL and reset crop selection state. */
function disposeCropSource(): void {
	if (cropSource.value) {
		URL.revokeObjectURL(cropSource.value.url);
	}
	cropSource.value = undefined;
	logoCrop.x = 0;
	logoCrop.y = 0;
	logoCrop.width = 1;
	logoCrop.height = 1;
	if (logoInput.value) {
		logoInput.value.value = '';
	}
}

/** Reset logo edits while preserving whether the saved logo is managed or external. */
function resetLogoEditor(logo: string | null): void {
	disposeCropSource();
	externalLogoUrl.value = managedChannelLogoId(logo) ? '' : (logo ?? '');
	removeLogoOnSave.value = false;
}

/** Close the channel form after releasing any temporary crop image. */
function closeForm(): void {
	disposeCropSource();
	showForm.value = false;
}

/** Debounce a server-side prediction and discard responses for superseded form values. */
function scheduleAccelerationPrediction(): void {
	if (accelerationPredictionTimer) {
		clearTimeout(accelerationPredictionTimer);
		accelerationPredictionTimer = undefined;
	}

	const sequence = ++accelerationPredictionSequence;
	accelerationPrediction.value = undefined;
	accelerationPredictionLoading.value = false;
	if (!showForm.value || form.video.accel !== 'automatic') {
		return;
	}

	accelerationPredictionLoading.value = true;
	accelerationPredictionTimer = setTimeout(async () => {
		accelerationPredictionTimer = undefined;
		try {
			const prediction = await api.predictHardwareAcceleration({
				format: form.video.format,
				bitDepth: form.video.bitDepth,
				width: form.video.width,
				height: form.video.height,
				vaapiDevice: form.video.vaapiDevice,
				vaapiDriver: form.video.vaapiDriver,
				ffmpegPath: form.ffmpegPath,
			});
			if (sequence === accelerationPredictionSequence) {
				accelerationPrediction.value = prediction;
			}
		}
		catch {
			if (sequence === accelerationPredictionSequence) {
				accelerationPrediction.value = {
					outcome: 'indeterminate',
					accel: null,
					detail: 'The server prediction request failed.',
				};
			}
		}
		finally {
			if (sequence === accelerationPredictionSequence) {
				accelerationPredictionLoading.value = false;
			}
		}
	}, 350);
}

/** Capture the pointer and starting geometry for a crop move or resize. */
function startCropInteraction(event: PointerEvent, mode: CropInteraction): void {
	logoDrag.active = true;
	logoDrag.mode = mode;
	logoDrag.pointerX = event.clientX;
	logoDrag.pointerY = event.clientY;
	logoDrag.cropX = logoCrop.x;
	logoDrag.cropY = logoCrop.y;
	logoDrag.cropWidth = logoCrop.width;
	logoDrag.cropHeight = logoCrop.height;
	(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

/** Move or resize the crop rectangle within the source image and minimum-size bounds. */
function moveCropInteraction(event: PointerEvent): void {
	const source = cropSource.value;
	if (!source || !logoDrag.active) {
		return;
	}

	const deltaX = (event.clientX - logoDrag.pointerX) / cropDisplayScale.value;
	const deltaY = (event.clientY - logoDrag.pointerY) / cropDisplayScale.value;
	if (logoDrag.mode === 'move') {
		logoCrop.x = Math.max(0, Math.min(source.width - logoDrag.cropWidth, logoDrag.cropX + deltaX));
		logoCrop.y = Math.max(
			0,
			Math.min(source.height - logoDrag.cropHeight, logoDrag.cropY + deltaY),
		);
		return;
	}

	const minimumWidth = Math.max(1, (source.width / LOGO_CROP_MAX_WIDTH) * 12);
	const minimumHeight = Math.max(1, (source.height / LOGO_CROP_MAX_HEIGHT) * 12);
	let left = logoDrag.cropX;
	let top = logoDrag.cropY;
	let right = logoDrag.cropX + logoDrag.cropWidth;
	let bottom = logoDrag.cropY + logoDrag.cropHeight;
	if (logoDrag.mode.includes('w')) {
		left = Math.max(0, Math.min(right - minimumWidth, logoDrag.cropX + deltaX));
	}
	if (logoDrag.mode.includes('e')) {
		right = Math.min(source.width, Math.max(left + minimumWidth, right + deltaX));
	}
	if (logoDrag.mode.includes('n')) {
		top = Math.max(0, Math.min(bottom - minimumHeight, logoDrag.cropY + deltaY));
	}
	if (logoDrag.mode.includes('s')) {
		bottom = Math.min(source.height, Math.max(top + minimumHeight, bottom + deltaY));
	}
	logoCrop.x = left;
	logoCrop.y = top;
	logoCrop.width = right - left;
	logoCrop.height = bottom - top;
}

/** Finish the active pointer-driven logo crop interaction. */
function endCropInteraction(): void {
	logoDrag.active = false;
}

/** Validate and load a selected image as an unconstrained initial crop. */
async function selectLogo(event: Event): Promise<void> {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	if (!file) {
		return;
	}

	error.value = '';
	if (file.size > LOGO_SOURCE_MAX_BYTES) {
		error.value = 'Choose an image smaller than 25 MiB.';
		input.value = '';
		return;
	}

	const url = URL.createObjectURL(file);
	const image = new Image();
	try {
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error('The selected file is not a supported image.'));
			image.src = url;
		});
		if (image.naturalWidth * image.naturalHeight > LOGO_SOURCE_MAX_PIXELS) {
			throw new Error('Choose an image with no more than 64 megapixels.');
		}

		disposeCropSource();
		cropSource.value = {
			url,
			image,
			width: image.naturalWidth,
			height: image.naturalHeight,
		};
		logoCrop.x = 0;
		logoCrop.y = 0;
		logoCrop.width = image.naturalWidth;
		logoCrop.height = image.naturalHeight;
		externalLogoUrl.value = '';
		removeLogoOnSave.value = false;
	}
	catch (cause) {
		URL.revokeObjectURL(url);
		error.value = errorMessage(cause);
	}
}

/** Clear staged logo data and mark the persisted logo for removal on save. */
function removeSelectedLogo(): void {
	disposeCropSource();
	externalLogoUrl.value = '';
	removeLogoOnSave.value = true;
}

/** Render the selected crop to a bounded PNG without upscaling. */
async function renderCroppedLogo(): Promise<Blob | null> {
	// Validate staged source data and derive output dimensions without upscaling.
	const source = cropSource.value;
	if (!source) {
		return null;
	}

	const maximumWidth = Math.min(form.video.width ?? 0, CHANNEL_LOGO_MAX_DIMENSION);
	const maximumHeight = Math.min(form.video.height ?? 0, CHANNEL_LOGO_MAX_DIMENSION);
	if (!maximumWidth || !maximumHeight) {
		throw new Error('Set a channel width and height before saving a logo.');
	}

	const outputScale = Math.min(1, maximumWidth / logoCrop.width, maximumHeight / logoCrop.height);
	let outputWidth = Math.max(1, Math.floor(logoCrop.width * outputScale));
	let outputHeight = Math.max(1, Math.floor(logoCrop.height * outputScale));
	const canvas = document.createElement('canvas');
	canvas.width = outputWidth;
	canvas.height = outputHeight;
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error('This browser cannot prepare the channel logo.');
	}

	// Draw the selected unconstrained crop and encode it as PNG.
	context.drawImage(
		source.image,
		logoCrop.x,
		logoCrop.y,
		logoCrop.width,
		logoCrop.height,
		0,
		0,
		outputWidth,
		outputHeight,
	);
	const encode = () =>
		new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (blob) {
					resolve(blob);
				}
				else {
					reject(new Error('The browser could not encode the channel logo.'));
				}
			}, 'image/png');
		});
	let encoded = await encode();

	// Reduce dimensions until the encoded logo satisfies the upload byte limit.
	while (encoded.size > CHANNEL_LOGO_MAX_BYTES && (outputWidth > 1 || outputHeight > 1)) {
		const reduction = Math.sqrt(CHANNEL_LOGO_MAX_BYTES / encoded.size) * 0.9;
		outputWidth = Math.max(1, Math.min(outputWidth - 1, Math.floor(outputWidth * reduction)));
		outputHeight = Math.max(1, Math.min(outputHeight - 1, Math.floor(outputHeight * reduction)));
		canvas.width = outputWidth;
		canvas.height = outputHeight;
		const reducedContext = canvas.getContext('2d');
		if (!reducedContext) {
			throw new Error('This browser cannot downsize the channel logo.');
		}

		reducedContext.drawImage(
			source.image,
			logoCrop.x,
			logoCrop.y,
			logoCrop.width,
			logoCrop.height,
			0,
			0,
			outputWidth,
			outputHeight,
		);
		encoded = await encode();
	}
	return encoded;
}

const weekLabel = computed(() => {
	if (!weekStart.value) {
		return '';
	}

	return `${formatDateKey(weekStart.value, { month: 'short', day: 'numeric' })} – ${formatDateKey(shiftDateKey(weekStart.value, 6), { month: 'short', day: 'numeric', year: 'numeric' })}`;
});
const canMovePrevious = computed(() =>
	Boolean(guide.value?.committedStartDate && weekStart.value > guide.value.committedStartDate));
const canMoveNext = computed(() =>
	Boolean(
		guide.value?.committedEndDate
		&& shiftDateKey(weekStart.value, 7) < guide.value.committedEndDate,
	));

/** Refresh shared channel data while preserving the store's cached loading state. */
async function loadChannels(): Promise<void> {
	await channelsStore.loadChannels();
}

/** Load the committed seven-day guide beginning at the selected date. */
async function loadGuide(): Promise<void> {
	if (!weekStart.value) {
		return;
	}

	await channelsStore.loadGuide(weekStart.value, 7);
}

/** Load channel, capability, schedule, and guide data without discarding cached state. */
async function loadInitial(): Promise<void> {
	const hasCachedPage
		= channelsLoaded.value
			&& capabilitiesLoaded.value
			&& guideLoaded.value
			&& guideDays.value >= 7
			&& Boolean(weekStart.value);
	if (!hasCachedPage) {
		initialLoading.value = true;
	}
	error.value = '';
	try {
		await Promise.all([loadChannels(), channelsStore.loadCapabilities(), scheduling.load()]);
		if (!weekStart.value) {
			weekStart.value = dateKey(new Date(), timeZone.value);
		}
		await loadGuide();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		initialLoading.value = false;
	}
}

/** Move the guide window within the committed range and load the resulting week. */
async function moveWeek(days: number): Promise<void> {
	if ((days < 0 && !canMovePrevious.value) || (days > 0 && !canMoveNext.value)) {
		return;
	}

	weekStart.value = shiftDateKey(weekStart.value, days);
	await loadGuide();
}

/** Reset the channel guide to the week containing today. */
async function showToday(): Promise<void> {
	weekStart.value = dateKey(new Date(), timeZone.value);
	await loadGuide();
}
/** Build the validated request body from the current editor form. */
function payload(): ChannelCreate {
	const result = cloneContractValue(form) as ChannelCreate;
	if (cropSource.value || managedChannelLogoId(form.logo)) {
		result.logo = form.logo;
	}
	else {
		result.logo = externalLogoUrl.value.trim() || null;
	}
	return result;
}
/** Open a blank channel form. */
function add() {
	Object.assign(form, defaults());
	resetLogoEditor(null);
	editingId.value = undefined;
	showForm.value = true;
}
/** Open an existing channel in the editor. */
function edit(channel: Channel) {
	const { id, createdAt, updatedAt, ...config } = channel;
	void id;
	void createdAt;
	void updatedAt;
	Object.assign(form, cloneContractValue(config) as ChannelCreate);
	resetLogoEditor(channel.logo);
	editingId.value = channel.id;
	showForm.value = true;
}
/** Save the channel form and any managed logo change. */
async function save() {
	error.value = '';
	saving.value = true;
	suppressChannelEventsUntil = Date.now() + 5_000;
	try {
		const croppedLogo = await renderCroppedLogo();
		const priorManagedLogo = managedChannelLogoId(form.logo);
		const replacementExternalLogo = externalLogoUrl.value.trim() || null;
		let saved: Channel;
		if (editingId.value) {
			saved = await api.updateChannel(editingId.value, payload());
		}
		else {
			saved = await api.createChannel(payload());
			editingId.value = saved.id;
		}
		if (croppedLogo) {
			saved = await api.uploadChannelLogo(saved.id, croppedLogo);
		}
		else if (priorManagedLogo && (removeLogoOnSave.value || replacementExternalLogo !== null)) {
			saved = await api.deleteChannelLogo(saved.id);
			if (replacementExternalLogo) {
				saved = await api.updateChannel(saved.id, {
					...payload(),
					logo: replacementExternalLogo,
				});
			}
		}
		void saved;
		closeForm();
		await Promise.all([loadChannels(), scheduling.load()]);
		await loadGuide();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		saving.value = false;
	}
}
/** Confirm and remove a channel. */
async function remove(id: string) {
	if (!confirm('Remove this channel?')) {
		return;
	}

	suppressChannelEventsUntil = Date.now() + 5_000;
	await api.deleteChannel(id);
	await loadChannels();
}
const unsubscribe = liveEvents.subscribe((event) => {
	if (event.type === 'channel.changed' && Date.now() < suppressChannelEventsUntil) {
		return;
	}

	if (affectsGuide(event)) {
		if (liveRefreshTimer) {
			clearTimeout(liveRefreshTimer);
		}
		liveRefreshTimer = setTimeout(() => {
			liveRefreshTimer = undefined;
			void Promise.all([channelsStore.loadChannels(), scheduling.load(), loadGuide()]);
		}, 180);
	}
});
watch(
	() => [
		showForm.value,
		form.video.accel,
		form.video.format,
		form.video.bitDepth,
		form.video.width,
		form.video.height,
		form.video.vaapiDevice,
		form.video.vaapiDriver,
		form.ffmpegPath,
	],
	scheduleAccelerationPrediction,
);
onMounted(() => void loadInitial());
onBeforeUnmount(() => {
	unsubscribe();
	accelerationPredictionSequence += 1;
	if (accelerationPredictionTimer) {
		clearTimeout(accelerationPredictionTimer);
	}
	if (liveRefreshTimer) {
		clearTimeout(liveRefreshTimer);
	}
});
</script>
<template>
	<section>
		<PageHeader
			eyebrow="Weekly playout"
			title="Channels"
			description="Review each channel against a seven-day broadcast timeline and manage its normalization profile."
		><button class="button" @click="add"><Plus :size="18" />New channel</button></PageHeader
		>
		<p v-if="error && !showForm" class="notice error">{{ error }}</p>
		<LoadingState v-if="initialLoading" label="Loading channels and guide…" />
		<template v-else>
			<div class="guide-toolbar">
				<div class="guide-week-controls">
					<button
						class="square-button"
						aria-label="Previous week"
						:disabled="!canMovePrevious"
						@click="moveWeek(-7)"
					>
						<ChevronLeft :size="18" />
					</button>
					<button class="toolbar-button" @click="showToday">
						<CalendarDays :size="17" />Today
					</button>
					<button
						class="square-button"
						aria-label="Next week"
						:disabled="!canMoveNext"
						@click="moveWeek(7)"
					>
						<ChevronRight :size="18" />
					</button>
					<strong>{{ weekLabel }}</strong>
				</div>
				<span class="guide-time-zone"><Clock3 :size="15" />{{ timeZone }}</span>
			</div>
			<GuideTimeline
				v-if="channels.length"
				:channels="channels"
				:guide="guide"
				:time-zone="timeZone"
				:start-date="weekStart"
				:days="7"
				empty-message="No template assigned"
			>
				<template #detail="{ channel, preview }">
					<small v-if="scheduleByChannel.get(channel.id)">
						{{
							scheduling.overview?.templates.find(
								(template) =>
									template.id === scheduleByChannel.get(channel.id)?.defaultTemplateId,
							)?.name ?? 'Missing template'
						}}
						<template v-if="scheduleByChannel.get(channel.id)?.layers.length">
							· {{ scheduleByChannel.get(channel.id)?.layers.length }} conditional
						</template>
						<span v-if="preview?.issues.length" class="guide-warning">
							· {{ preview.issues.length }} warnings
						</span>
					</small>
				</template>
				<template #actions="{ channel }">
					<button
						class="icon-button"
						:aria-label="`Edit ${channel.name}`"
						@click="edit(channel)"
					>
						<Pencil :size="16" />
					</button>
					<button
						class="icon-button danger-icon"
						:aria-label="`Remove ${channel.name}`"
						@click="remove(channel.id)"
					>
						<Trash2 :size="16" />
					</button>
				</template>
			</GuideTimeline>
			<div v-else-if="!error" class="empty-state">
				<span>⌁</span>
				<h3>No channels configured</h3>
				<p>Create a channel, tune normalization, and stream it directly from Moirai.</p>
			</div>
		</template>
		<div v-if="showForm" class="moirai-dialog-backdrop" @click.self="closeForm">
			<form class="moirai-dialog" @submit.prevent="save">
				<div class="modal-heading">
					<div>
						<p class="eyebrow">{{ editingId ? 'Edit' : 'New' }} channel</p>
						<h2>Broadcast profile</h2>
					</div>
					<button type="button" class="icon-button" aria-label="Close" @click="closeForm">
						<X :size="20" />
					</button>
				</div>
				<fieldset>
					<legend>Lineup</legend>
					<div class="form-grid">
						<label
						><span>Number</span
						><input v-model="form.number" required pattern="[A-Za-z0-9._-]+" /></label
						><label><span>Name</span><input v-model="form.name" required /></label
						><label><span>Group</span><input v-model="form.group" /></label>
						<div class="span-2 channel-schedule-link">
							<span>Schedule</span>
							<RouterLink
								v-if="editingId"
								class="button secondary"
								:to="`/schedules/channels/${editingId}`"
							>
								Manage layered schedule
							</RouterLink>
							<small v-else>Save the channel before configuring its schedule.</small>
						</div>
						<div class="channel-logo-editor span-2">
							<div class="channel-logo-heading">
								<span>Channel logo</span>
								<small>PNG on save · maximum {{ configuredLogoLimit }}</small>
							</div>
							<input
								ref="logoInput"
								class="visually-hidden"
								type="file"
								accept="image/*"
								@change="selectLogo"
							/>
							<div v-if="cropSource" class="channel-logo-workspace">
								<div class="channel-logo-crop-area">
									<div
										class="channel-logo-crop-stage"
										:class="{ dragging: logoDrag.active }"
										:style="cropStageStyle"
										role="img"
										aria-label="Channel logo crop preview"
										@pointermove="moveCropInteraction"
										@pointerup="endCropInteraction"
										@pointercancel="endCropInteraction"
									>
										<img :src="cropSource.url" alt="" draggable="false" />
										<div
											class="channel-logo-selection"
											:style="cropSelectionStyle"
											@pointerdown="startCropInteraction($event, 'move')"
										>
											<button
												v-for="handle in cropHandles"
												:key="handle"
												type="button"
												class="channel-logo-crop-handle"
												:class="`handle-${handle}`"
												:aria-label="`Resize crop ${handle}`"
												@pointerdown.stop="startCropInteraction($event, handle)"
											></button>
										</div>
									</div>
								</div>
								<div class="channel-logo-controls">
									<p>
										Drag the selection to move it. Resize any edge or corner freely; its aspect
										ratio is not constrained.
									</p>
									<p class="channel-logo-crop-size">
										Selected: {{ Math.round(logoCrop.width) }}×{{ Math.round(logoCrop.height) }}
										source pixels
									</p>
									<div class="channel-logo-buttons">
										<button type="button" class="button secondary" @click="logoInput?.click()">
											<ImagePlus :size="16" />Choose another
										</button>
										<button type="button" class="button secondary" @click="removeSelectedLogo">
											<Trash2 :size="16" />Remove
										</button>
									</div>
								</div>
							</div>
							<div v-else class="channel-logo-picker">
								<div class="channel-logo-current">
									<img v-if="existingLogoUrl()" :src="existingLogoUrl() ?? undefined" alt="" />
									<ImagePlus v-else :size="30" />
								</div>
								<div>
									<button type="button" class="button secondary" @click="logoInput?.click()">
										<Upload :size="16" />Choose image
									</button>
									<button
										v-if="existingLogoUrl() || removeLogoOnSave"
										type="button"
										class="text-button danger-text"
										@click="removeSelectedLogo"
									>
										Remove logo
									</button>
									<p>JPEG, PNG, WebP, or another browser-supported image up to 25 MiB.</p>
								</div>
							</div>
							<label class="channel-logo-url">
								<span>Or use an external logo URL</span>
								<input
									v-model="externalLogoUrl"
									type="url"
									placeholder="https://…"
									:disabled="Boolean(cropSource)"
									@input="removeLogoOnSave = false"
								/>
							</label>
						</div>
					</div>
				</fieldset>
				<fieldset>
					<legend>Video normalization</legend>
					<div class="form-grid three">
						<label
						><span>Format</span
						><select v-model="form.video.format">
							<option value="h264">H.264</option>
							<option value="hevc">HEVC</option>
						</select></label
						><label
						><span>Width</span><input v-model.number="form.video.width" type="number" /></label
						><label
						><span>Height</span><input v-model.number="form.video.height" type="number" /></label
						><label
						><span>Bitrate kbps</span
						><input v-model.number="form.video.bitrateKbps" type="number" /></label
						><label
						><span>Buffer kbps</span
						><input v-model.number="form.video.bufferKbps" type="number" /></label
						><label
						><span>Bit depth</span
						><input v-model.number="form.video.bitDepth" type="number" /></label
						><label
						><span>Scaling</span
						><select v-model="form.video.scalingMode">
							<option value="scale_and_pad">Scale and pad</option>
							<option value="stretch">Stretch</option>
							<option value="crop">Crop</option>
						</select></label
						><label class="acceleration-field"
						><span>Acceleration</span
						><select v-model="form.video.accel">
							<option value="automatic">Automatic</option>
							<option :value="null">None</option>
							<option value="amf">AMF</option>
							<option value="cuda">CUDA</option>
							<option value="qsv">QSV</option>
							<option value="rkmpp">RKMPP</option>
							<option value="vaapi">VAAPI</option>
							<option value="videotoolbox">VideoToolbox</option>
							<option value="vulkan">Vulkan</option>
						</select
						><small
							v-if="form.video.accel === 'automatic' && accelerationPredictionText"
							class="acceleration-prediction"
							role="status"
							:title="accelerationPrediction?.detail"
						>{{ accelerationPredictionText }}</small
						></label
						><label class="check"
						><input v-model="form.video.deinterlace" type="checkbox" /> Deinterlace</label
						>
					</div>
				</fieldset>
				<fieldset>
					<legend>Audio normalization</legend>
					<div class="form-grid three">
						<label
						><span>Format</span
						><select v-model="form.audio.format">
							<option value="aac">AAC</option>
							<option value="ac3">AC3</option>
						</select></label
						><label
						><span>Bitrate kbps</span
						><input v-model.number="form.audio.bitrateKbps" type="number" /></label
						><label
						><span>Channels</span
						><input v-model.number="form.audio.channels" type="number" /></label
						><label
						><span>Sample rate</span
						><input v-model.number="form.audio.sampleRateHz" type="number" /></label
						><label class="check"
						><input v-model="form.audio.normalizeLoudness" type="checkbox" /> Normalize
							loudness</label
						><label
						><span>Subtitle mode</span
						><select v-model="form.subtitleMode">
							<option value="burn">Burn</option>
							<option value="convert">Convert</option>
						</select></label
						>
					</div>
				</fieldset>
				<p v-if="error" class="notice error">{{ error }}</p>
				<div class="form-actions">
					<button type="button" class="button secondary" :disabled="saving" @click="closeForm">
						Cancel</button
					><button class="button" :disabled="saving">
						{{ saving ? 'Saving…' : 'Save changes' }}
					</button>
				</div>
			</form>
		</div>
	</section>
</template>
