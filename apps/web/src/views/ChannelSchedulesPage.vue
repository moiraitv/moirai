<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import {
	ArrowDown,
	ArrowUp,
	CircleAlert,
	CircleCheck,
	CircleHelp,
	Info,
	Layers3,
	Pencil,
	Plus,
	RefreshCw,
	Trash2,
} from '@lucide/vue';
import {
	channelScheduleConfigSchema,
	MAX_CHANNEL_SCHEDULE_LAYERS,
	type ChannelScheduleConfig,
	type ChannelScheduleLayer,
	type ChannelTimelineMaterializationStatus,
	type LayerBoundary,
	type SchedulePredicate,
	type ScheduleSlot,
	type ScheduleTemplate,
	type TimelinePreview,
} from '@moirai/shared';
import { api } from '../api';
import { requestConfirmation } from '../confirmation';
import { errorMessage } from '../error-message';
import { randomUuid } from '../random-uuid';
import LoadingState from '../components/LoadingState.vue';
import AnimatedDisclosure from '../components/AnimatedDisclosure.vue';
import DisabledActionHint from '../components/DisabledActionHint.vue';
import ResourceEditorActionBar from '../components/ResourceEditorActionBar.vue';
import ResourceEditorHeader from '../components/ResourceEditorHeader.vue';
import TwoStepActionButton from '../components/TwoStepActionButton.vue';
import ChannelScheduleCatalog from '../components/schedules/ChannelScheduleCatalog.vue';
import ChannelSchedulesAbout from '../components/schedules/ChannelSchedulesAbout.vue';
import LayeredSchedulingGuide from '../components/schedules/LayeredSchedulingGuide.vue';
import PageHeader from '../components/PageHeader.vue';
import SchedulePredicateEditor from '../components/SchedulePredicateEditor.vue';
import TemplatesPage from './TemplatesPage.vue';
import { schedulePreviewLegend, scheduleRulerMarks } from '../channel-schedule-preview';
import {
	schedulePredicateSummary,
	scheduleTemplateName,
	templateRepresentativeStyle as representativeStyle,
	templateSlotStyle,
} from '../channel-schedule-display';
import { dateKey } from '../date-key';
import { guideSegmentPercent, guideWindowMilliseconds } from '../guide-geometry';
import { programColorStyle } from '../program-colors';
import { useChannelsStore } from '../stores/channels';
import { useSchedulingStore } from '../stores/scheduling';
import { DISMISSIBLE_HELP_STORAGE_KEYS, useDismissibleHelp } from '../dismissible-help';
import { liveEvents } from '../live-events';
import { closeUnsavedEditor } from '../unsaved-editor';

const PREVIEW_DELAY_MS = 450;
const route = useRoute();
const router = useRouter();
const channelsStore = useChannelsStore();
const scheduling = useSchedulingStore();
const {
	visible: channelSchedulesHelpVisible,
	dismiss: dismissChannelSchedulesHelp,
	show: showChannelSchedulesHelp,
} = useDismissibleHelp(DISMISSIBLE_HELP_STORAGE_KEYS.channelSchedules);
const { capabilitiesLoaded, channels, guide, guideLoaded, guideWeekStart, timeZone }
	= storeToRefs(channelsStore);
const cachedListGuide
	= guideLoaded.value
		&& guideWeekStart.value === dateKey(new Date(), timeZone.value)
		&& (guide.value?.days ?? 0) >= 1;
const initialLoading = ref(
	!(channelsStore.loaded && scheduling.loaded && channelsStore.capabilitiesLoaded)
	|| (!route.params.id && !cachedListGuide),
);
const draft = ref<ChannelScheduleConfig | null>(null);
const original = ref('');
const selectedLayerId = ref<string | null>(null);
const quickEditingTemplateId = ref<string | null>(null);
const saving = ref(false);
const deleting = ref(false);
const error = ref('');
const preview = ref<TimelinePreview | null>(null);
const previewWindowMilliseconds = computed(() => preview.value
	? guideWindowMilliseconds(preview.value.startDate, preview.value.days, preview.value.timeZone)
	: 0);
const previewing = ref(false);
const listGuideError = ref('');
const guideExpanded = ref(false);
const previewDate = ref(dateKey(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone));
const previewRuler = scheduleRulerMarks();
const materializations = ref<ChannelTimelineMaterializationStatus[]>([]);
const applyingTimeline = ref(false);
/** Editable layer plus UI-only expansion state for its predicate groups. */
type BoundarySide = 'entryBoundary' | 'exitBoundary';
const finiteBoundaryDrift = new Map<string, number>();
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewRevision = 0;
let allowRouteLeave = false;

const channelId = computed(() => String(route.params.id ?? ''));
const editing = computed(() => Boolean(channelId.value));
const previewIssuesOpen = ref(false);
const channel = computed(() => channels.value.find((entry) => entry.id === channelId.value));
const materialization = computed(() =>
	materializations.value.find((entry) => entry.channelId === channelId.value));
const templates = computed(() => scheduling.overview?.templates ?? []);
const schedules = computed(() => scheduling.overview?.channelSchedules ?? []);
const hasPersistedSchedule = ref(false);
const selectedLayer = computed(() =>
	draft.value?.layers.find((layer) => layer.id === selectedLayerId.value));
const isDirty = computed(
	() => Boolean(draft.value) && JSON.stringify(draft.value) !== original.value,
);
const scheduleNeedsSave = computed(() =>
	Boolean(draft.value) && (!hasPersistedSchedule.value || isDirty.value));
const scheduleFormValid = computed(() => channelScheduleConfigSchema.safeParse(draft.value).success);
const previewLegend = computed(() =>
	schedulePreviewLegend(preview.value, templates.value, draft.value?.defaultTemplateId ?? null));

/** Return the display name for template. */
function templateName(id: string): string {
	return scheduleTemplateName(templates.value, id);
}

/** Return CSS presentation values for template representative. */
function templateRepresentativeStyle(id: string): Record<string, string> {
	return representativeStyle(templates.value, id);
}

/** Restore the layered-scheduling explainer after dismissal. */
function showLayeredGuide(): void {
	guideExpanded.value = true;
	requestAnimationFrame(() => {
		document.getElementById('layered-scheduling-guide')?.scrollIntoView({
			behavior: 'smooth',
			block: 'nearest',
		});
	});
}

/** Load today's committed guide once when the channel list needs programming summaries. */
async function loadListGuide(): Promise<void> {
	if (editing.value || schedules.value.length === 0) {
		return;
	}

	const today = dateKey(new Date(), timeZone.value);
	if (guideLoaded.value && guideWeekStart.value === today && (guide.value?.days ?? 0) >= 1) {
		return;
	}

	try {
		await channelsStore.loadGuide(today, 1);
		listGuideError.value = '';
	}
	catch (cause) {
		listGuideError.value = errorMessage(cause);
	}
}

/** Format an absolute preview timestamp in the configured time zone. */
function previewTime(value: string): string {
	return new Intl.DateTimeFormat([], {
		timeZone: preview.value?.timeZone,
		hour: 'numeric',
		minute: '2-digit',
	}).format(new Date(value));
}

/** Return CSS presentation values for slot. */
function slotStyle(template: ScheduleTemplate, slot: ScheduleSlot): Record<string, string> {
	return templateSlotStyle(template, slot);
}

/** Summarize predicate for display. */
function predicateSummary(predicate: SchedulePredicate): string {
	return schedulePredicateSummary(predicate);
}

/** Clone the selected channel schedule or initialize a valid base-only draft. */
function loadDraft(): void {
	finiteBoundaryDrift.clear();
	hasPersistedSchedule.value = false;
	if (!editing.value || templates.value.length === 0) {
		draft.value = null;
		return;
	}

	const existing = schedules.value.find((schedule) => schedule.channelId === channelId.value);
	hasPersistedSchedule.value = Boolean(existing);
	draft.value = channelScheduleConfigSchema.parse(
		existing ?? {
			defaultTemplateId: templates.value[0]!.id,
			layers: [],
			defaultFiller: null,
		},
	);
	selectedLayerId.value = draft.value.layers[0]?.id ?? null;
	for (const layer of draft.value.layers) {
		for (const side of ['entryBoundary', 'exitBoundary'] as const) {
			const drift = layer[side].maxDriftSeconds;
			if (drift !== null) {
				finiteBoundaryDrift.set(`${layer.id}:${side}`, drift);
			}
		}
	}
	original.value = JSON.stringify(draft.value);
	preview.value = null;
}

/** Create the initial hard entry or exit boundary for a new layer. */
function defaultBoundary(): LayerBoundary {
	return { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left' };
}

/** Change a layer boundary policy while restoring finite drift when required. */
function updateLayerBoundaryPolicy(side: BoundarySide, policy: LayerBoundary['policy']): void {
	if (!selectedLayer.value) {
		return;
	}

	const boundary = selectedLayer.value[side];
	if (policy !== 'finish-left' && boundary.maxDriftSeconds === null) {
		boundary.maxDriftSeconds = finiteBoundaryDrift.get(`${selectedLayer.value.id}:${side}`) ?? 0;
	}
	boundary.policy = policy;
}

/** Store a finite maximum drift in seconds for one side of the selected layer. */
function updateLayerBoundaryDrift(side: BoundarySide, minutes: number): void {
	if (!selectedLayer.value) {
		return;
	}

	const maxDriftSeconds = minutes * 60;
	finiteBoundaryDrift.set(`${selectedLayer.value.id}:${side}`, maxDriftSeconds);
	selectedLayer.value[side].maxDriftSeconds = maxDriftSeconds;
}

/** Switch a layer boundary between unlimited drift and its last finite limit. */
function toggleUnlimitedLayerDrift(side: BoundarySide, unlimited: boolean): void {
	if (!selectedLayer.value) {
		return;
	}

	const boundary = selectedLayer.value[side];
	const key = `${selectedLayer.value.id}:${side}`;
	if (unlimited) {
		if (boundary.maxDriftSeconds !== null) {
			finiteBoundaryDrift.set(key, boundary.maxDriftSeconds);
		}
		boundary.maxDriftSeconds = null;
		return;
	}

	boundary.maxDriftSeconds = finiteBoundaryDrift.get(key) ?? 0;
}

/** Add a highest-priority conditional layer with a valid all-week default predicate. */
function addLayer(): void {
	if (
		!draft.value
		|| templates.value.length === 0
		|| draft.value.layers.length >= MAX_CHANNEL_SCHEDULE_LAYERS
	) {
		return;
	}

	const layer: ChannelScheduleLayer = {
		id: randomUuid(),
		templateId: templates.value[0]!.id,
		predicate: {
			type: 'all',
			children: [{ type: 'weekdays', values: [1, 2, 3, 4, 5, 6, 7], negated: false }],
		},
		entryBoundary: defaultBoundary(),
		exitBoundary: defaultBoundary(),
	};
	draft.value.layers.unshift(layer);
	selectedLayerId.value = layer.id;
}

/** Move a conditional layer by one position while preserving explicit stack priority. */
function moveLayer(index: number, direction: -1 | 1): void {
	if (!draft.value) {
		return;
	}

	const target = index + direction;
	if (target < 0 || target >= draft.value.layers.length) {
		return;
	}

	const layers = [...draft.value.layers];
	[layers[index], layers[target]] = [layers[target]!, layers[index]!];
	draft.value.layers = layers;
}

/** Remove a conditional layer and select its nearest remaining neighbor. */
function removeLayer(id: string): void {
	if (!draft.value) {
		return;
	}

	const removedIndex = draft.value.layers.findIndex((layer) => layer.id === id);
	draft.value.layers = draft.value.layers.filter((layer) => layer.id !== id);
	if (selectedLayerId.value === id) {
		selectedLayerId.value
			= draft.value.layers[removedIndex]?.id ?? draft.value.layers[removedIndex - 1]?.id ?? null;
	}
}

/** Open one stack template in the embedded quick editor. */
function editTemplate(templateId: string): void {
	quickEditingTemplateId.value = templateId;
}

/** Close the quick template editor and immediately refresh the layered preview. */
function finishTemplateEdit(): void {
	quickEditingTemplateId.value = null;
	schedulePreview(0);
}

/** Validate and save the selected channel's layered schedule. */
async function save(): Promise<boolean> {
	if (!draft.value || !channel.value || saving.value || !scheduleNeedsSave.value) {
		return false;
	}

	saving.value = true;
	error.value = '';
	try {
		const saved = await api.setChannelSchedule(
			channel.value.id,
			channelScheduleConfigSchema.parse(draft.value),
		);
		hasPersistedSchedule.value = true;
		draft.value = channelScheduleConfigSchema.parse(saved);
		original.value = JSON.stringify(draft.value);
		try {
			await Promise.all([scheduling.load(), loadMaterializations()]);
		}
		catch (cause) {
			error.value = `Schedule saved, but timeline status could not be refreshed. ${errorMessage(cause)}`;
		}
		return true;
	}
	catch (cause) {
		error.value = errorMessage(cause);
		return false;
	}
	finally {
		saving.value = false;
	}
}

/** Leave the channel schedule editor without triggering its general navigation guard. */
async function leaveScheduleEditor(): Promise<void> {
	allowRouteLeave = true;
	try {
		await router.push('/schedules/channels');
	}
	finally {
		allowRouteLeave = false;
	}
}

/** Save, discard, or retain a channel schedule before closing its editor. */
async function closeScheduleEditor(): Promise<void> {
	await closeUnsavedEditor({
		blocked: saving.value || deleting.value,
		dirty: scheduleNeedsSave.value,
		key: `unsaved-channel-schedule:${channel.value?.id ?? 'new'}`,
		message: 'Save this channel schedule before closing?',
		save: async () => {
			if (await save()) {
				await leaveScheduleEditor();
			}
		},
		discard: leaveScheduleEditor,
	});
}

/** Restore the authored schedule and preview to the baseline captured on open. */
function resetSchedule(): void {
	loadDraft();
	error.value = '';
	schedulePreview(0);
}

/** Refresh committed timeline health for pending-change controls. */
async function loadMaterializations(): Promise<void> {
	materializations.value = await api.timelineMaterializations();
}

/** Format the last committed timeline update for display. */
function materializationTime(value: string | null | undefined): string {
	if (!value) {
		return '';
	}

	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: timeZone.value,
	}).format(new Date(value));
}

/** Apply pending schedule changes after the currently committed item. */
async function applyTimelineNow(): Promise<void> {
	if (
		!channel.value
		|| applyingTimeline.value
		|| scheduleNeedsSave.value
		|| materialization.value?.health !== 'pending'
	) {
		return;
	}

	applyingTimeline.value = true;
	error.value = '';
	try {
		await api.applyChannelTimelineNow(channel.value.id);
		await loadMaterializations();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		applyingTimeline.value = false;
	}
}

/** Confirm and remove the selected channel's authored and generated schedule state. */
async function removeSchedule(): Promise<void> {
	const selectedChannel = channel.value;
	if (!selectedChannel || !hasPersistedSchedule.value || saving.value || deleting.value || !(await requestConfirmation({
		key: `remove-channel-schedule:${selectedChannel.id}`,
		title: 'Delete Channel Schedule?',
		message: `Delete the authored and generated schedule for ${selectedChannel.name} and discard any unsaved changes?`,
		confirmLabel: 'Delete Channel Schedule',
		destructive: true,
	}))) {
		return;
	}

	deleting.value = true;
	error.value = '';
	try {
		await api.deleteChannelSchedule(selectedChannel.id);
		await scheduling.load();
		await leaveScheduleEditor();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		deleting.value = false;
	}
}

/** Validate and materialize the layered draft unless a newer preview superseded it. */
async function generatePreview(revision: number): Promise<void> {
	if (!draft.value || !channel.value || revision !== previewRevision) {
		return;
	}

	previewing.value = true;
	try {
		const result = await api.draftChannelSchedulePreview({
			channelId: channel.value.id,
			schedule: channelScheduleConfigSchema.parse(draft.value),
			startDate: previewDate.value,
			days: 1,
		});
		if (revision === previewRevision) {
			preview.value = result;
			error.value = '';
		}
	}
	catch (cause) {
		if (revision === previewRevision) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		if (revision === previewRevision) {
			previewing.value = false;
		}
	}
}

/** Coalesce layered draft changes before requesting a new materialized preview. */
function schedulePreview(delay = PREVIEW_DELAY_MS): void {
	previewRevision += 1;
	const revision = previewRevision;
	if (previewTimer !== undefined) {
		clearTimeout(previewTimer);
	}
	if (!draft.value) {
		return;
	}

	previewTimer = setTimeout(() => {
		previewTimer = undefined;
		void generatePreview(revision);
	}, delay);
}

/** Warn before navigation when the current editor contains unsaved changes. */
function beforeUnload(event: BeforeUnloadEvent): void {
	if (scheduleNeedsSave.value) {
		event.preventDefault();
	}
}

/** Leave the schedule editor with Escape when no nested template editor owns the event. */
function handleEditorKeydown(event: KeyboardEvent): void {
	if (
		!event.defaultPrevented
		&& editing.value
		&& !quickEditingTemplateId.value
		&& event.key === 'Escape'
	) {
		event.preventDefault();
		void closeScheduleEditor();
	}
}

onBeforeRouteLeave(async () => allowRouteLeave || !scheduleNeedsSave.value || requestConfirmation({
	key: `discard-channel-schedule:${channel.value?.id ?? 'new'}`,
	title: 'Discard Unsaved Changes?',
	message: 'Leave this channel schedule without saving your changes?',
	confirmLabel: 'Discard Changes',
	destructive: true,
}));
watch(
	() => route.params.id,
	() => {
		loadDraft();
		void loadListGuide();
	},
);
watch([draft, previewDate], () => schedulePreview(), { deep: true });
onMounted(async () => {
	window.addEventListener('beforeunload', beforeUnload);
	document.addEventListener('keydown', handleEditorKeydown);
	try {
		await Promise.all([
			channelsStore.loadChannels(),
			scheduling.load(),
			loadMaterializations(),
			capabilitiesLoaded.value ? Promise.resolve() : channelsStore.loadCapabilities(),
		]);
		previewDate.value = dateKey(new Date(), timeZone.value);
		loadDraft();
		if (editing.value) {
			schedulePreview(0);
		}
		else {
			await loadListGuide();
		}
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		initialLoading.value = false;
	}
});
const unsubscribeTimeline = liveEvents.subscribe((event) => {
	if (event.type === 'timeline.changed') {
		void Promise.all([
			loadMaterializations(),
			editing.value ? Promise.resolve() : loadListGuide(),
		]).catch(() => undefined);
	}
});
onBeforeUnmount(() => {
	unsubscribeTimeline();
	window.removeEventListener('beforeunload', beforeUnload);
	document.removeEventListener('keydown', handleEditorKeydown);
	previewRevision += 1;
	if (previewTimer !== undefined) {
		clearTimeout(previewTimer);
	}
});
</script>

<template>
	<section class="channel-schedules-page" :class="{ 'editing-schedule': editing }">
		<PageHeader
			eyebrow="Layered channel programming"
			title="Channel schedules"
			description="Choose a channel to configure its base and conditional template stack."
		>
			<Transition name="context-popover">
				<button
					v-if="!editing && !channelSchedulesHelpVisible"
					type="button"
					class="page-help-button"
					aria-label="Show channel schedule help"
					@click="showChannelSchedulesHelp"
				>
					<CircleHelp :size="20" />
				</button>
			</Transition>
		</PageHeader>
		<LoadingState v-if="initialLoading" label="Loading channel schedules…" />
		<p v-else-if="error && !editing" class="notice error">{{ error }}</p>

		<div v-else class="async-state-surface">
			<ChannelSchedulesAbout
				:visible="!editing && channelSchedulesHelpVisible"
				@dismiss="dismissChannelSchedulesHelp"
				@learn="showLayeredGuide"
			/>

			<div class="channel-schedules-content">
				<p v-if="listGuideError" class="notice error">
					Schedule previews are temporarily unavailable: {{ listGuideError }}
				</p>

				<ChannelScheduleCatalog
					:channels="channels"
					:schedules="schedules"
					:templates="templates"
					:guide="guide"
				/>
				<LayeredSchedulingGuide :expanded="guideExpanded" @show="showLayeredGuide" />
			</div>
		</div>

		<Teleport to="body">
			<div
				v-if="editing && !initialLoading"
				class="moirai-dialog-backdrop"
				@click.self="closeScheduleEditor"
			>
				<div
					class="moirai-dialog scheduling-workspace-modal channel-schedule-modal"
					role="dialog"
					aria-modal="true"
					aria-label="Channel schedule editor"
				>
					<ResourceEditorHeader close-label="Close channel schedule editor" :disabled="saving || deleting" @close="closeScheduleEditor">
						<p class="eyebrow">Layered channel programming</p>
						<h2>{{ channel?.name ?? 'Channel schedule' }}</h2>
						<p>Stack conditional templates above an always-available base template.</p>
					</ResourceEditorHeader>

					<div v-if="templates.length === 0" class="empty-state scheduling-modal-empty">
						<h3>Create a template first</h3>
						<p>A channel schedule needs an always-available base template.</p>
						<RouterLink class="button" to="/schedules/templates/new">New Template</RouterLink>
					</div>

					<template v-else-if="draft && channel">
						<div class="channel-schedule-toolbar editor-surface">
							<span class="channel-schedule-save-state" :class="{ dirty: scheduleNeedsSave }">
								<CircleAlert v-if="scheduleNeedsSave" :size="22" />
								<CircleCheck v-else :size="22" />
								<span>
									<strong>{{ scheduleNeedsSave ? 'Unsaved changes' : 'All changes saved' }}</strong>
									<small v-if="!scheduleNeedsSave && materialization?.health === 'pending'">
										Programming update scheduled for
										{{ materializationTime(materialization.applyAfter) }}
									</small>
									<small v-else-if="!scheduleNeedsSave && materialization?.health === 'failed'">
										The last timeline update failed; the prior committed guide remains active.
									</small>
								</span>
							</span>
							<div class="channel-schedule-toolbar-actions">
								<DisabledActionHint
									v-if="scheduleNeedsSave"
									label="Apply After Current Item"
									message="Save the schedule before applying it after the current item."
								>
									<button type="button" class="button secondary" disabled>
										<RefreshCw :size="17" />Apply After Current Item
									</button>
								</DisabledActionHint>
								<button
									v-else-if="materialization?.health === 'pending'"
									type="button"
									class="button secondary"
									:disabled="applyingTimeline"
									@click="applyTimelineNow"
								>
									<RefreshCw :size="17" :class="{ spinning: applyingTimeline }" />
									{{ applyingTimeline ? 'Applying…' : 'Apply After Current Item' }}
								</button>
							</div>
						</div>
						<div class="scheduling-workspace-scroll">
							<p v-if="error" class="notice error">{{ error }}</p>

							<div class="schedule-editor-columns">
								<section class="schedule-stack editor-surface" aria-label="Template priority stack">
									<div class="schedule-stack-heading">
										<div><Layers3 :size="20" /><strong>Template stack</strong></div>
										<small>Highest priority</small>
									</div>
									<div class="schedule-layer-add-placeholder">
										<button
											type="button"
											class="button secondary"
											:disabled="draft.layers.length >= MAX_CHANNEL_SCHEDULE_LAYERS"
											@click="addLayer"
										>
											<Plus :size="17" />Add Conditional Template
										</button>
									</div>
									<article
										v-for="(layer, index) in draft.layers"
										:key="layer.id"
										class="schedule-layer conditional"
										:class="{ selected: selectedLayerId === layer.id }"
										@click="selectedLayerId = layer.id"
									>
										<div class="schedule-layer-order">
											<button
												type="button"
												:disabled="index === 0"
												aria-label="Move layer up"
												@click.stop="moveLayer(index, -1)"
											>
												<ArrowUp :size="15" />
											</button>
											<button
												type="button"
												:disabled="index === draft.layers.length - 1"
												aria-label="Move layer down"
												@click.stop="moveLayer(index, 1)"
											>
												<ArrowDown :size="15" />
											</button>
										</div>
										<div class="schedule-layer-copy">
											<strong>{{ templateName(layer.templateId) }}</strong>
											<small>{{ predicateSummary(layer.predicate) }}</small>
										</div>
										<div class="schedule-layer-mini-track">
											<span
												v-for="slot in templates.find(
													(template) => template.id === layer.templateId,
												)?.slots ?? []"
												:key="slot.id"
												:class="{ 'fall-through-slot': slot.programId === null }"
												:style="
													slotStyle(
														templates.find((template) => template.id === layer.templateId)!,
														slot,
													)
												"
											></span>
										</div>
										<div class="schedule-layer-actions">
											<TwoStepActionButton
												class="icon-button danger-icon layer-remove-button"
												label="Remove layer"
												confirm-label="Confirm remove layer"
												@click.stop
												@confirm="removeLayer(layer.id)"
											>
												<Trash2 :size="16" />
											</TwoStepActionButton>
										</div>
									</article>
									<article
										class="schedule-layer base"
										:class="{ selected: selectedLayerId === null }"
										@click="selectedLayerId = null"
									>
										<div class="schedule-layer-copy">
											<span class="eyebrow">Base template</span>
											<strong>{{ templateName(draft.defaultTemplateId) }}</strong>
											<small>Fallback programming</small>
										</div>
										<div
											class="schedule-layer-mini-track"
											aria-label="Base template slot structure"
										>
											<span
												v-for="slot in templates.find(
													(template) => template.id === draft?.defaultTemplateId,
												)?.slots ?? []"
												:key="slot.id"
												:class="{ 'fall-through-slot': slot.programId === null }"
												:style="
													slotStyle(
														templates.find((template) => template.id === draft?.defaultTemplateId)!,
														slot,
													)
												"
											></span>
										</div>
									</article>
									<small class="schedule-stack-bottom">Base priority</small>
								</section>

								<section v-if="selectedLayer" class="schedule-layer-inspector editor-surface">
									<div class="template-panel-heading">
										<div class="layer-editor-title">
											<p class="eyebrow">Conditional layer</p>
											<label class="layer-template-picker layer-title-picker">
												<span class="sr-only">Conditional layer template</span>
												<span class="layer-template-select">
													<i :style="templateRepresentativeStyle(selectedLayer.templateId)"></i>
													<select
														v-model="selectedLayer.templateId"
														aria-label="Conditional layer template"
													>
														<option
															v-for="template in templates"
															:key="template.id"
															:value="template.id"
														>
															{{ template.name }}
														</option>
													</select>
												</span>
											</label>
										</div>
										<button
											type="button"
											class="toolbar-button"
											:aria-label="`Edit ${templateName(selectedLayer.templateId)}`"
											@click="editTemplate(selectedLayer.templateId)"
										>
											<Pencil :size="16" />Edit Template
										</button>
									</div>
									<h3>Show this layer when</h3>
									<SchedulePredicateEditor
										v-model="selectedLayer.predicate"
										:time-zone="timeZone"
									/>
									<div class="layer-boundary-grid">
										<fieldset
											v-for="side in ['entryBoundary', 'exitBoundary'] as const"
											:key="side"
										>
											<legend>
												{{ side === 'entryBoundary' ? 'Entry boundary' : 'Exit boundary' }}
											</legend>
											<p class="layer-boundary-description">
												{{
													side === 'entryBoundary'
														? 'When this layer starts, control lower-priority programming that is already playing.'
														: 'When this layer ends, control its programming as lower-priority programming resumes.'
												}}
											</p>
											<label
											><span>Boundary behavior</span
											><select
												:value="selectedLayer[side].policy"
												@change="
													updateLayerBoundaryPolicy(
														side,
														($event.target as HTMLSelectElement).value as LayerBoundary['policy'],
													)
												"
											>
												<option value="hard">Hard boundary</option>
												<option value="finish-left">Finish outgoing item within drift</option>
												<option value="favor-right">Favor incoming content</option>
											</select></label
											>
											<label v-if="selectedLayer[side].policy !== 'hard'"
											><span>Maximum drift past boundary (minutes)</span
											><input
												type="number"
												min="0"
												max="1440"
												:disabled="selectedLayer[side].maxDriftSeconds === null"
												:value="(selectedLayer[side].maxDriftSeconds ?? 0) / 60"
												@input="
													updateLayerBoundaryDrift(
														side,
														Number(($event.target as HTMLInputElement).value),
													)
												"
											/><small>
												Outgoing content may shift the incoming programming by at most this
												amount.
											</small></label
											>
											<label
												v-if="selectedLayer[side].policy === 'finish-left'"
												class="check-row boundary-unlimited-control"
											>
												<input
													type="checkbox"
													:checked="selectedLayer[side].maxDriftSeconds === null"
													@change="
														toggleUnlimitedLayerDrift(
															side,
															($event.target as HTMLInputElement).checked,
														)
													"
												/>
												<span>No limit — always finish outgoing item</span>
											</label>
											<label
											><span>If the next outgoing item cannot satisfy this boundary</span
											><select
												v-model="selectedLayer[side].fallback"
												:disabled="selectedLayer[side].maxDriftSeconds === null"
											>
												<option value="truncate-left">Truncate outgoing content</option>
												<option value="reject-start">Do not start it</option>
											</select></label
											>
										</fieldset>
									</div>
								</section>

								<section v-else class="schedule-layer-inspector base-inspector editor-surface">
									<div class="template-panel-heading">
										<div class="layer-editor-title">
											<p class="eyebrow">Base template</p>
											<label class="layer-template-picker layer-title-picker">
												<span class="sr-only">Base template</span>
												<span class="layer-template-select">
													<i :style="templateRepresentativeStyle(draft.defaultTemplateId)"></i>
													<select v-model="draft.defaultTemplateId" aria-label="Base template">
														<option
															v-for="template in templates"
															:key="template.id"
															:value="template.id"
														>
															{{ template.name }}
														</option>
													</select>
												</span>
											</label>
										</div>
										<button
											type="button"
											class="toolbar-button"
											:aria-label="`Edit ${templateName(draft.defaultTemplateId)}`"
											@click="editTemplate(draft.defaultTemplateId)"
										>
											<Pencil :size="16" />Edit Template
										</button>
									</div>
									<p class="base-inspector-description">
										The base supplies programming whenever no higher-priority conditional layer
										applies or when a conditional template explicitly falls through.
									</p>
									<div
										class="base-inspector-track"
										aria-label="Selected base template slot structure"
									>
										<span
											v-for="slot in templates.find(
												(template) => template.id === draft?.defaultTemplateId,
											)?.slots ?? []"
											:key="slot.id"
											:class="{ 'fall-through-slot': slot.programId === null }"
											:style="
												slotStyle(
													templates.find((template) => template.id === draft?.defaultTemplateId)!,
													slot,
												)
											"
										></span>
									</div>
								</section>
							</div>

						</div>

						<section class="resolved-preview scheduling-preview-dock editor-surface">
							<div class="template-panel-heading preview-heading">
								<div>
									<p class="eyebrow">Materialized output</p>
									<h2>Preview layered schedule</h2>
								</div>
								<div class="preview-controls">
									<label class="preview-control-field"
									><span>Preview date</span><input v-model="previewDate" type="date"
									/></label>
									<button class="toolbar-button" :disabled="previewing" @click="schedulePreview(0)">
										<RefreshCw :size="16" :class="{ spinning: previewing }" />{{
											previewing ? 'Updating…' : 'Refresh Now'
										}}
									</button>
								</div>
							</div>
							<div v-if="preview" class="schedule-preview-ruler" aria-hidden="true">
								<span v-for="mark in previewRuler" :key="mark.seconds">{{ mark.label }}</span>
							</div>
							<div v-if="preview" class="resolved-track">
								<div
									v-for="segment in preview.segments"
									:key="segment.id"
									class="resolved-segment"
									:class="`role-${segment.role}`"
									:style="{
										...programColorStyle(segment.programId),
										width: `${guideSegmentPercent(
											segment.start,
											segment.finish,
											previewWindowMilliseconds,
										)}%`,
									}"
									:title="`${segment.title}\n${segment.start}–${segment.finish}`"
								>
									<strong>{{ segment.title }}</strong
									><small>{{ previewTime(segment.start) }}–{{ previewTime(segment.finish) }}</small>
								</div>
							</div>
							<div
								v-if="previewLegend.length"
								class="schedule-preview-legend"
								aria-label="Schedule preview legend"
							>
								<div v-for="entry in previewLegend" :key="entry.templateId">
									<span class="schedule-preview-legend-swatch">
										<i
											v-for="programId in entry.programIds"
											:key="programId ?? 'fall-through'"
											:class="{ 'fall-through-slot': programId === null }"
											:style="programColorStyle(programId)"
										></i>
									</span>
									<span> {{ entry.name }}<small v-if="entry.isBase"> (Base template)</small> </span>
								</div>
							</div>
							<AnimatedDisclosure
								v-if="preview?.issues.length"
								v-model="previewIssuesOpen"
								class="schedule-preview-issues compact-preview-issues"
								aria-label="Schedule preview issues"
							>
								<template #summary><span>
									{{ preview.issues.length }} preview issue{{
										preview.issues.length === 1 ? '' : 's'
									}}
								</span></template>
								<ul>
									<li
										v-for="issue in preview.issues"
										:key="`${issue.slotId}:${issue.code}:${issue.programId}:${issue.mediaItemId}`"
									>
										<Info :size="17" />
										<span>{{ issue.message }}</span>
									</li>
								</ul>
							</AnimatedDisclosure>
						</section>
						<ResourceEditorActionBar
							resource-type="Channel Schedule"
							:show-delete="hasPersistedSchedule"
							:busy="saving || deleting"
							:deleting="deleting"
							:reset-disabled="!isDirty"
							:save-disabled="!scheduleNeedsSave || !scheduleFormValid"
							:saving="saving"
							@delete="removeSchedule"
							@reset="resetSchedule"
							@save="save"
						/>
					</template>
				</div>
			</div>
		</Teleport>

		<Teleport to="body">
			<TemplatesPage
				v-if="quickEditingTemplateId"
				embedded
				:template-id="quickEditingTemplateId"
				@close="quickEditingTemplateId = null"
				@saved="finishTemplateEdit"
			/>
		</Teleport>
	</section>
</template>
