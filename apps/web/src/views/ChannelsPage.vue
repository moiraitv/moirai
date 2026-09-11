<script setup lang="ts">
import PageHelpButton from '../components/PageHelpButton.vue';
import { useDisclosureState } from '../disclosure-state';
import EncodingProfileSelector from '../components/EncodingProfileSelector.vue';
import FormDisclosure from '../components/FormDisclosure.vue';
import ChannelEncodingSettings from '../components/ChannelEncodingSettings.vue';
import AudioPreferencesEditor from '../components/AudioPreferencesEditor.vue';
import SubtitlePreferencesEditor from '../components/SubtitlePreferencesEditor.vue';
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { RouterLink, onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import {
	CalendarDays,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Clock3,
	Pencil,
	Plus,
	ImagePlus,
	RadioTower,
	Trash2,
	Upload,
	Video,
} from '@lucide/vue';
import {
	CHANNEL_LOGO_MAX_BYTES,
	CHANNEL_LOGO_MAX_DIMENSION,
	channelCreateSchema,
	managedChannelLogoId,
	type Channel,
	type ChannelCreate,
	type FallbackFillerStatus,
} from '@moirai/shared';
import type { HardwareAccelerationPrediction } from '@moirai/shared/api-contracts';
import { api } from '../api';
import { requestConfirmation } from '../confirmation';
import { formatHardwareAccelerationPrediction } from '../channel-acceleration';
import { channelLogoUrl } from '../channel-logo';
import { loadChannelLogoImage, renderChannelLogoPng } from '../channel-logo-image';
import { calendarDateSpan, dateKey, formatDateKey, shiftDateKey } from '../date-key';
import { errorMessage } from '../error-message';
import GuideTimeline from '../components/GuideTimeline.vue';
import DisabledActionHint from '../components/DisabledActionHint.vue';
import FallbackFillerEditor from '../components/FallbackFillerEditor.vue';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import ResourceEditorActionBar from '../components/ResourceEditorActionBar.vue';
import ResourceEditorHeader from '../components/ResourceEditorHeader.vue';
import ResourceEmptyState from '../components/ResourceEmptyState.vue';
import TwoStepActionButton from '../components/TwoStepActionButton.vue';
import { liveEvents } from '../live-events';
import { affectsGuide } from '../guide-events';
import { cloneContractValue } from '../reactive-clone';
import { closeUnsavedEditor } from '../unsaved-editor';
import { useChannelsStore } from '../stores/channels';
import { useSchedulingStore } from '../stores/scheduling';
import { channelScheduleSummary } from '../channel-schedule-display';

const channelsStore = useChannelsStore();
const route = useRoute();
const router = useRouter();
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
const encodingProfilesReady = ref(false);
let leavingPage = false;
const error = ref('');
const logoInput = ref<HTMLInputElement>();
const removeLogoOnSave = ref(false);
const fallbackStatus = ref<FallbackFillerStatus | null>(null);
const fallbackFile = ref<File | null>(null);
const fallbackExpanded = useDisclosureState('channel-fallback', false);
const removeFallbackOnSave = ref(false);
const fallbackLoading = ref(false);
const saving = ref(false);
const deleting = ref(false);
const originalFormSnapshot = ref('');
const formBaseline = ref<ChannelCreate | null>(null);
const accelerationPrediction = ref<HardwareAccelerationPrediction>();
const accelerationPredictionLoading = ref(false);
let liveRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let accelerationPredictionTimer: ReturnType<typeof setTimeout> | undefined;
let accelerationPredictionSequence = 0;
let fallbackLoadSequence = 0;
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
const defaults = (): ChannelCreate => ({
	encodingProfileId: null,
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
	subtitlePreferences: {},
	audioPreferences: {},
	subtitleFontsFolder: null,
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

/** Summarize one channel's base and conditional schedule for its guide row. */
function scheduleSummary(channelId: string): string {
	return channelScheduleSummary(
		scheduleByChannel.value.get(channelId),
		scheduling.overview?.templates ?? [],
	);
}

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

	return form.logo;
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

/** Clear staged crop and removal state while retaining the saved logo in the channel draft. */
function resetLogoEditor(): void {
	disposeCropSource();
	removeLogoOnSave.value = false;
}

/** Serialize persisted channel fields plus pending logo edits for dirty-state comparison. */
function channelFormSnapshot(): string {
	return JSON.stringify({
		form,
		removeLogoOnSave: removeLogoOnSave.value,
		crop: cropSource.value ? { source: cropSource.value.url, ...logoCrop } : null,
		fallbackFile: fallbackFile.value
			? {
				name: fallbackFile.value.name,
				size: fallbackFile.value.size,
				lastModified: fallbackFile.value.lastModified,
			}
			: null,
		removeFallbackOnSave: removeFallbackOnSave.value,
	});
}

const channelFormDirty = computed(() =>
	showForm.value && channelFormSnapshot() !== originalFormSnapshot.value);
const channelFormValid = computed(() => channelCreateSchema.safeParse(payload()).success);
const channelSaveDisabled = computed(() =>
	saving.value || (!editingId.value && !encodingProfilesReady.value) || !channelFormValid.value || (Boolean(editingId.value) && !channelFormDirty.value));

/** Close the channel form after releasing any temporary crop image. */
function finishCloseForm(): void {
	fallbackLoadSequence += 1;
	disposeCropSource();
	fallbackFile.value = null;
	removeFallbackOnSave.value = false;
	fallbackStatus.value = null;
	fallbackLoading.value = false;
	showForm.value = false;
	if (!leavingPage && route.query.new === '1') {
		const query = { ...route.query };
		delete query.new;
		void router.replace({ path: '/channels', query });
	}
}

/** Load the effective fallback and any override owned by the channel editor. */
async function loadEditorFallback(channelId?: string): Promise<void> {
	const sequence = ++fallbackLoadSequence;
	fallbackLoading.value = true;
	fallbackStatus.value = null;
	try {
		let loaded: FallbackFillerStatus;
		if (channelId) {
			loaded = await api.channelFallbackFiller(channelId);
		}
		else {
			const global = await api.globalFallbackFiller();
			loaded = {
				...global,
				override: null,
				overrideConfigured: false,
				effective: global.effective,
				inherited: global.effective,
				overrideError: null,
			};
		}
		if (sequence === fallbackLoadSequence) {
			fallbackStatus.value = loaded;
		}
	}
	catch (cause) {
		if (sequence === fallbackLoadSequence) {
			error.value = errorMessage(cause);
			fallbackStatus.value = null;
		}
	}
	finally {
		if (sequence === fallbackLoadSequence) {
			fallbackLoading.value = false;
		}
	}
}

/** Save, discard, or retain a channel draft before closing its editor. */
async function closeForm(): Promise<void> {
	await closeUnsavedEditor({
		blocked: saving.value || deleting.value,
		dirty: channelFormDirty.value,
		key: `unsaved-channel:${editingId.value ?? 'new'}`,
		message: 'Save this channel before closing?',
		save,
		discard: finishCloseForm,
	});
}

onBeforeRouteLeave(async () => {
	leavingPage = true;
	try {
		if (showForm.value) {
			await closeForm();
		}
		return !showForm.value;
	}
	finally {
		leavingPage = false;
	}
});

/** Close the channel editor with Escape when no confirmation owns the event. */
function handleEditorKeydown(event: KeyboardEvent): void {
	if (!event.defaultPrevented && showForm.value && event.key === 'Escape') {
		event.preventDefault();
		void closeForm();
	}
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
	try {
		const source = await loadChannelLogoImage(file);
		disposeCropSource();
		cropSource.value = source;
		logoCrop.x = 0;
		logoCrop.y = 0;
		logoCrop.width = source.width;
		logoCrop.height = source.height;
		removeLogoOnSave.value = false;
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
}

/** Clear staged logo data and mark the persisted logo for removal on save. */
function removeSelectedLogo(): void {
	disposeCropSource();
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

	return await renderChannelLogoPng(
		source.image,
		logoCrop,
		maximumWidth,
		maximumHeight,
		CHANNEL_LOGO_MAX_BYTES,
	);
}

const displayedDays = computed(() => guide.value?.days ?? 7);
const requestedWindowDays = computed(() => {
	return requestedDaysFor(weekStart.value);
});

/** Bound one guide request to the remaining committed range from its proposed start. */
function requestedDaysFor(startDate: string): number {
	const committedEndDate = guide.value?.committedEndDate;
	if (!committedEndDate || !startDate) {
		return 7;
	}

	return Math.max(1, Math.min(7, calendarDateSpan(startDate, committedEndDate)));
}
const weekLabel = computed(() => {
	if (!weekStart.value) {
		return '';
	}

	return `${formatDateKey(weekStart.value, { month: 'short', day: 'numeric' })} – ${formatDateKey(shiftDateKey(weekStart.value, displayedDays.value - 1), { month: 'short', day: 'numeric', year: 'numeric' })}`;
});
const canMovePrevious = computed(() =>
	channelsStore.guideNavigationTarget('backward') !== null);
const canMoveNext = computed(() =>
	channelsStore.guideNavigationTarget('forward') !== null);

/** Refresh shared channel data while preserving the store's cached loading state. */
async function loadChannels(): Promise<void> {
	await channelsStore.loadChannels();
}

/** Load the committed seven-day guide beginning at the selected date. */
async function loadGuide(): Promise<void> {
	if (!weekStart.value) {
		return;
	}

	await channelsStore.loadGuide(weekStart.value, requestedWindowDays.value);
}

/** Load channel, capability, schedule, and guide data without discarding cached state. */
async function loadInitial(): Promise<void> {
	const hasCachedPage
		= channelsLoaded.value
			&& capabilitiesLoaded.value
			&& guideLoaded.value
			&& guideDays.value >= requestedWindowDays.value
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
async function moveWindow(direction: -1 | 1): Promise<void> {
	if ((direction < 0 && !canMovePrevious.value) || (direction > 0 && !canMoveNext.value)) {
		return;
	}

	const target = channelsStore.guideNavigationTarget(direction < 0 ? 'backward' : 'forward');
	if (!target) {
		return;
	}

	await channelsStore.loadGuide(
		target,
		requestedDaysFor(target),
		direction < 0 ? 'backward' : 'forward',
	);
}

/** Reset the channel guide to the week containing today. */
async function showToday(): Promise<void> {
	const today = dateKey(new Date(), timeZone.value);
	await channelsStore.loadGuide(today, requestedDaysFor(today));
	channelsStore.clearGuideNavigationHistory();
}
/** Build the validated request body from the current editor form. */
function payload(): ChannelCreate {
	const result = cloneContractValue(form) as ChannelCreate;
	if (removeLogoOnSave.value && !managedChannelLogoId(form.logo)) {
		result.logo = null;
	}
	return result;
}

/** Adopt already-persisted channel fields while preserving an unsaved fallback operation for retry. */
function retainFallbackDraftAfterPartialSave(saved: Channel): void {
	const pendingFallbackFile = fallbackFile.value;
	const pendingFallbackRemoval = removeFallbackOnSave.value;
	const { id, createdAt, updatedAt, ...config } = saved;
	void createdAt;
	void updatedAt;
	Object.assign(form, defaults(), cloneContractValue(config) as ChannelCreate);
	resetLogoEditor();
	editingId.value = id;
	formBaseline.value = cloneContractValue(config) as ChannelCreate;
	fallbackFile.value = null;
	removeFallbackOnSave.value = false;
	originalFormSnapshot.value = channelFormSnapshot();
	fallbackFile.value = pendingFallbackFile;
	removeFallbackOnSave.value = pendingFallbackRemoval;
}

/** Adopt the asynchronously loaded default into the opening baseline without capturing user edits. */
function encodingProfilesLoaded(ready: boolean): void {
	if (ready && !encodingProfilesReady.value && !editingId.value && formBaseline.value) {
		const encoding = { encodingProfileId: form.encodingProfileId ?? null, audio: cloneContractValue(form.audio), video: cloneContractValue(form.video) };
		Object.assign(formBaseline.value, encoding);
		const original = JSON.parse(originalFormSnapshot.value) as { form: ChannelCreate };
		Object.assign(original.form, encoding);
		originalFormSnapshot.value = JSON.stringify(original);
	}
	encodingProfilesReady.value = ready;
}

/** Open a blank channel form. */
function add() {
	encodingProfilesReady.value = false;
	Object.assign(form, defaults());
	resetLogoEditor();
	fallbackFile.value = null;
	removeFallbackOnSave.value = false;
	editingId.value = undefined;
	void loadEditorFallback();
	formBaseline.value = cloneContractValue(form) as ChannelCreate;
	originalFormSnapshot.value = channelFormSnapshot();
	showForm.value = true;
}

/** Open an existing channel in the editor. */
function edit(channel: Channel) {
	const { id, createdAt, updatedAt, ...config } = channel;
	void id;
	void createdAt;
	void updatedAt;
	Object.assign(form, defaults(), cloneContractValue(config) as ChannelCreate);
	resetLogoEditor();
	fallbackFile.value = null;
	removeFallbackOnSave.value = false;
	editingId.value = channel.id;
	void loadEditorFallback(channel.id);
	formBaseline.value = cloneContractValue(config) as ChannelCreate;
	originalFormSnapshot.value = channelFormSnapshot();
	showForm.value = true;
}
/** Save the channel form and any managed logo change. */
async function save() {
	if (channelSaveDisabled.value) {
		return;
	}

	error.value = '';
	saving.value = true;
	suppressChannelEventsUntil = Date.now() + 5_000;
	try {
		const croppedLogo = await renderCroppedLogo();
		const priorManagedLogo = managedChannelLogoId(form.logo);
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
		else if (priorManagedLogo && removeLogoOnSave.value) {
			saved = await api.deleteChannelLogo(saved.id);
		}
		try {
			if (fallbackFile.value) {
				fallbackStatus.value = await api.uploadChannelFallbackFiller(saved.id, fallbackFile.value);
			}
			else if (removeFallbackOnSave.value && fallbackStatus.value?.overrideConfigured) {
				fallbackStatus.value = await api.deleteChannelFallbackFiller(saved.id);
			}
		}
		catch (cause) {
			retainFallbackDraftAfterPartialSave(saved);
			error.value = `Channel changes were saved, but the fallback filler was not: ${errorMessage(cause)}`;
			await Promise.allSettled([loadChannels(), scheduling.load(), loadGuide()]);
			return;
		}
		void saved;
		finishCloseForm();
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
/** Restore the editor to the channel values captured when it opened. */
function resetChannel(): void {
	if (!formBaseline.value) {
		return;
	}

	const baseline = cloneContractValue(formBaseline.value) as ChannelCreate;
	Object.assign(form, defaults(), baseline);
	resetLogoEditor();
	fallbackFile.value = null;
	removeFallbackOnSave.value = false;
	error.value = '';
}

/** Confirm and delete the channel being edited. */
async function deleteChannel(): Promise<void> {
	const id = editingId.value;
	if (!id || saving.value || deleting.value) {
		return;
	}

	const selected = channels.value.find((channel) => channel.id === id);
	if (!(await requestConfirmation({
		key: `delete-channel:${id}`,
		title: 'Delete Channel?',
		message: selected
			? `Delete ${selected.name} and its generated schedule, and discard any unsaved changes?`
			: 'Delete this channel and its generated schedule, and discard any unsaved changes?',
		confirmLabel: 'Delete Channel',
		destructive: true,
	}))) {
		return;
	}

	deleting.value = true;
	error.value = '';
	try {
		suppressChannelEventsUntil = Date.now() + 5_000;
		await api.deleteChannel(id);
		finishCloseForm();
		await Promise.all([loadChannels(), scheduling.load()]);
		await loadGuide();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		deleting.value = false;
	}
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

/** Open the blank channel creator when requested through the durable channel entry URL. */
watch(
	() => route.query.new,
	(value) => {
		if (value === '1' && !showForm.value) {
			add();
		}
	},
	{ immediate: true },
);

onMounted(() => {
	document.addEventListener('keydown', handleEditorKeydown);
	void loadInitial();
});
onBeforeUnmount(() => {
	unsubscribe();
	document.removeEventListener('keydown', handleEditorKeydown);
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
		><button class="button" @click="add"><Plus :size="18" />New Channel</button></PageHeader
		>
		<p v-if="error && !showForm" class="notice error">{{ error }}</p>
		<LoadingState v-if="initialLoading" label="Loading channels and guide…" />
		<div v-else class="async-state-surface">
			<div class="guide-toolbar">
				<div class="guide-week-controls">
					<button
						class="square-button"
						aria-label="Previous week"
						:disabled="!canMovePrevious"
						@click="moveWindow(-1)"
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
						@click="moveWindow(1)"
					>
						<ChevronRight :size="18" />
					</button>
					<strong>{{ weekLabel }}</strong>
				</div>
				<span class="guide-time-zone"><Clock3 :size="15" />{{ timeZone }}</span>
			</div>
			<p v-if="guide?.segmentLimitApplied" class="notice warning">
				Showing {{ guide.days }} of {{ guide.requestedDays }} requested days because this
				schedule contains an unusually high number of programs.
			</p>
			<GuideTimeline
				v-if="channels.length"
				:channels="channels"
				:guide="guide"
				:time-zone="timeZone"
				:start-date="weekStart"
				:days="displayedDays"
				empty-message="No template assigned"
				show-technical-details
			>
				<template #detail="{ channel }">
					<small class="channel-schedule-summary">{{ scheduleSummary(channel.id) }}</small>
				</template>
				<template #actions="{ channel }">
					<button
						class="icon-button"
						:aria-label="`Edit ${channel.name}`"
						@click="edit(channel)"
					>
						<Pencil :size="16" />
					</button>
				</template>
			</GuideTimeline>
			<ResourceEmptyState
				v-else-if="!error"
				title="No channels configured"
				description="Create a channel, tune normalization, and stream it directly from Moirai."
			>
				<template #icon><RadioTower :size="37" /></template>
				<div class="form-actions">
					<RouterLink class="button" to="/quick"><Plus :size="18" />Quick Setup</RouterLink>
					<button class="button secondary" type="button" @click="add">Advanced Channel</button>
				</div>
			</ResourceEmptyState>
		</div>
		<div v-if="showForm" class="moirai-dialog-backdrop" @click.self="closeForm">
			<form
				class="moirai-dialog resource-editor-modal channel-editor-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="channel-editor-title"
				@submit.prevent="save"
			>
				<ResourceEditorHeader close-label="Close channel editor" :disabled="saving || deleting" @close="closeForm">
					<p class="eyebrow">{{ editingId ? 'Edit' : 'New' }} channel</p>
					<div class="resource-editor-title-with-help"><h2 id="channel-editor-title">Broadcast profile</h2><PageHelpButton label="Channels" topic-id="channels.manage" /></div>
				</ResourceEditorHeader>
				<div class="resource-editor-scroll">
					<div class="channel-identity-fields">
						<label
						><span>Number</span
						><input v-model="form.number" required pattern="[A-Za-z0-9._-]+" /></label
						><label><span>Name</span><input v-model="form.name" autocapitalize="words" required /></label
						><label><span>Group</span><input v-model="form.group" autocapitalize="words" /></label>
					</div>
					<div class="channel-schedule-link">
						<span>Schedule</span>
						<RouterLink
							v-if="editingId && !channelFormDirty"
							class="button secondary"
							:to="`/schedules/channels/${editingId}`"
						>
							Manage Layered Schedule
						</RouterLink>
						<DisabledActionHint
							v-else
							label="Manage Layered Schedule"
							message="Save the channel before configuring its schedule."
						>
							<button type="button" class="button secondary" disabled>
								Manage Layered Schedule
							</button>
						</DisabledActionHint>
					</div>
					<div class="channel-logo-editor">
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
										<ImagePlus :size="16" />Choose Another
									</button>
									<TwoStepActionButton
										class="icon-button danger-text"
										label="Remove selected logo"
										confirm-label="Confirm remove selected logo"
										@confirm="removeSelectedLogo"
									>
										<Trash2 :size="17" />
									</TwoStepActionButton>
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
									<Upload :size="16" />Choose Image
								</button>
								<TwoStepActionButton
									v-if="existingLogoUrl()"
									class="icon-button danger-text"
									label="Remove logo"
									confirm-label="Confirm remove logo"
									@confirm="removeSelectedLogo"
								>
									<Trash2 :size="17" />
								</TwoStepActionButton>
								<p>JPEG, PNG, WebP, or another browser-supported image up to 25 MiB.</p>
							</div>
						</div>

					</div>

					<EncodingProfileSelector v-model="form.encodingProfileId" v-model:audio="form.audio" v-model:video="form.video" :use-default="!editingId" @ready="encodingProfilesLoaded">
						<ChannelEncodingSettings v-model:audio="form.audio" v-model:video="form.video" :profile-id="form.encodingProfileId" :acceleration-prediction-text="accelerationPredictionText" :acceleration-detail="accelerationPrediction?.detail" />
					</EncodingProfileSelector>
					<AudioPreferencesEditor v-model="form.audioPreferences" />
					<SubtitlePreferencesEditor v-model="form.subtitlePreferences" channel-layout :channel-id="editingId" :mode="form.subtitleMode">
						<label><span>Subtitle mode</span><select v-model="form.subtitleMode"><option value="burn">Burn</option><option value="convert">Convert</option></select></label>
						<label><span>Subtitle fonts folder</span><input :value="form.subtitleFontsFolder ?? ''" placeholder="Use installed system fonts" @input="form.subtitleFontsFolder = ($event.target as HTMLInputElement).value.trim() || null" /></label>
					</SubtitlePreferencesEditor>
					<FormDisclosure v-model:open="fallbackExpanded" class="channel-fallback-disclosure">
						<template #summary>
							<span class="form-disclosure-icon" aria-hidden="true"><Video :size="26" /></span>
							<span class="form-disclosure-copy"><strong>Channel fallback override</strong><small>Use a fallback video just for this channel</small></span>
							<ChevronDown class="form-disclosure-chevron" :size="22" aria-hidden="true" />
						</template>
						<FallbackFillerEditor
							v-model:selected-file="fallbackFile"
							v-model:remove-on-save="removeFallbackOnSave"
							heading="Channel fallback override"
							removal-source="Effective global fallback after save"
							:status="fallbackStatus"
							:loading="fallbackLoading"
							:disabled="saving || deleting"
							@validation-error="error = $event"
						/>
					</FormDisclosure>
					<p v-if="error" class="notice error">{{ error }}</p>
				</div>
				<ResourceEditorActionBar
					resource-type="Channel"
					:show-delete="Boolean(editingId)"
					:busy="saving || deleting"
					:deleting="deleting"
					:reset-disabled="!channelFormDirty"
					:save-disabled="channelSaveDisabled"
					save-submits
					:saving="saving"
					@delete="deleteChannel"
					@reset="resetChannel"
				/>
			</form>
		</div>
	</section>
</template>
