<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import {
	Clock3,
	Pencil,
	Trash2,
} from '@lucide/vue';
import {
	SECONDS_PER_SCHEDULING_DAY,
	type ScheduleBoundary,
	type ScheduleSlot,
	type ScheduleTemplateCreate,
	type TimelinePreview,
	timelineDraftPreviewSchema,
} from '@moirai/shared';
import { api } from '../../api';
import { requestConfirmation } from '../../confirmation';
import { errorMessage } from '../../error-message';
import LoadingState from '../LoadingState.vue';
import AnimatedDisclosure from '../AnimatedDisclosure.vue';
import ProgramsPage from '../../views/ProgramsPage.vue';
import { cloneContractValue } from '../../reactive-clone';
import { randomUuid } from '../../random-uuid';
import {
	deleteScheduleSlot,
	midpointSlotPlacement,
	moveScheduleBoundary,
	slotPlacementForTime,
	splitScheduleSlot,
	timelineSlotPlacement,
	SLOT_PLACEMENT_STEP_SECONDS,
	type SlotPlacement,
} from '../../schedule-geometry';
import { useChannelsStore } from '../../stores/channels';
import { useSchedulingStore } from '../../stores/scheduling';
import { scheduleClockLabel } from '../../time-format';
import ResolvedSchedulePreview from './ResolvedSchedulePreview.vue';
import TemplateAssignments from './TemplateAssignments.vue';
import TemplateTimelineEditor from './TemplateTimelineEditor.vue';

const PREVIEW_UPDATE_DELAY_MS = 450;

const props = withDefaults(
	defineProps<{
		embedded?: boolean;
		templateId?: string | null;
	}>(),
	{ embedded: false, templateId: null },
);
const emit = defineEmits<{
	close: [];
	saved: [templateId: string];
}>();

const route = useRoute();
const router = useRouter();
const scheduling = useSchedulingStore();
const channelsStore = useChannelsStore();
const { capabilitiesLoaded, channels } = storeToRefs(channelsStore);
const initialLoading = ref(
	!(scheduling.loaded && channelsStore.loaded && channelsStore.capabilitiesLoaded),
);
const draft = ref<(ScheduleTemplateCreate & { id: string }) | null>(null);
const selectedSlotId = ref('');
const assignedChannelIds = ref<string[]>([]);
const originalSnapshot = ref('');
const saving = ref(false);
const error = ref('');
const preview = ref<TimelinePreview | null>(null);
const previewStale = ref(false);
const previewing = ref(false);
const previewQueued = ref(false);
const previewError = ref('');
const quickEditingProgramId = ref<string | null>(null);
const timelineEditor = ref<{ timelineBar?: HTMLElement }>();
const editorView = ref<'timeline' | 'list'>('timeline');
const addingSlot = ref(false);
const slotPlacement = ref<SlotPlacement | null>(null);
const placementAnnouncement = ref('');
const advancedOpen = ref(false);
const finiteBoundaryDrift = new Map<string, number>();
const editing = computed(() =>
	props.embedded ? Boolean(props.templateId) : route.params.id !== undefined);
const editingId = computed(() =>
	props.embedded
		? props.templateId
		: route.params.id === 'new'
			? null
			: String(route.params.id ?? ''));
const programs = computed(() => scheduling.overview?.programs ?? []);
const templates = computed(() => scheduling.overview?.templates ?? []);
const selectedSlot = computed(() =>
	draft.value?.slots.find((slot) => slot.id === selectedSlotId.value));
const selectedBoundary = computed(() =>
	draft.value?.boundaries.find((boundary) => boundary.leftSlotId === selectedSlotId.value));
const sortedSlots = computed(() =>
	[...(draft.value?.slots ?? [])].sort((left, right) => left.startSeconds - right.startSeconds));
const splittablePlacements = computed(() => {
	if (!draft.value) {
		return [];
	}

	return sortedSlots.value.flatMap((slot) => {
		const placement = midpointSlotPlacement(draft.value!, slot.id);
		return placement ? [placement] : [];
	});
});
const canAddSlot = computed(() => splittablePlacements.value.length > 0);
const placementStyle = computed(() => {
	const percentage = ((slotPlacement.value?.splitSeconds ?? 0) / SECONDS_PER_SCHEDULING_DAY) * 100;
	return {
		left: `${percentage}%`,
		'--placement-label-shift': percentage < 6 ? '0%' : percentage > 94 ? '-100%' : '-50%',
	};
});
const assignedChannels = computed(() =>
	channels.value.filter((channel) => assignedChannelIds.value.includes(channel.id)));
const usedPrograms = computed(() => {
	const seen = new Set<string>();
	return sortedSlots.value.flatMap((slot) => {
		if (slot.programId === null) {
			return [];
		}

		if (seen.has(slot.programId)) {
			return [];
		}

		seen.add(slot.programId);
		return [{ id: slot.programId, name: programName(slot.programId) }];
	});
});
const isDirty = computed(() =>
	draft.value ? JSON.stringify({ template: draft.value }) !== originalSnapshot.value : false);
const previewDraftFingerprint = computed(() => {
	if (!draft.value) {
		return '';
	}

	return JSON.stringify({
		id: draft.value.id,
		period: draft.value.period,
		defaultFiller: draft.value.defaultFiller,
		slots: draft.value.slots,
		boundaries: draft.value.boundaries,
	});
});

/** Return the display name for program. */
function programName(id: string | null): string {
	if (id === null) {
		return 'No program — fall through';
	}

	return programs.value.find((program) => program.id === id)?.name ?? 'Missing program';
}

/** Return the user-facing label for time. */
function timeLabel(seconds: number): string {
	return scheduleClockLabel(seconds, true);
}

/** Return the user-facing label for slot duration. */
function slotDurationLabel(slot: ScheduleSlot): string {
	const seconds = Math.max(0, slotEnd(slot) - slot.startSeconds);
	if (seconds === SECONDS_PER_SCHEDULING_DAY) {
		return 'All day';
	}

	const hours = Math.floor(seconds / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	if (hours && minutes) {
		return `${hours}h ${minutes}m`;
	}

	return hours ? `${hours}h` : `${minutes}m`;
}

/** Parse a valid nominal-day clock value, including the terminal `24:00` boundary. */
function parseTime(value: string): number | null {
	const match = value.match(/^(\d{1,2}):(\d{2})$/);
	if (!match) {
		return null;
	}

	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) {
		return null;
	}

	return hours * 3_600 + minutes * 60;
}

/** Resolve the nominal end of a template slot from its outgoing boundary. */
function slotEnd(slot: ScheduleSlot): number {
	return (
		draft.value?.boundaries.find((boundary) => boundary.leftSlotId === slot.id)?.targetSeconds
		?? SECONDS_PER_SCHEDULING_DAY
	);
}

/** Serialize the current draft for dirty-state comparison. */
function snapshot(): string {
	return JSON.stringify({ template: draft.value });
}

/** Clone an existing template or initialize a complete one-slot daily draft. */
function loadDraft(): void {
	addingSlot.value = false;
	slotPlacement.value = null;
	finiteBoundaryDrift.clear();
	if (!editing.value) {
		draft.value = null;
		return;
	}

	const existing = templates.value.find((template) => template.id === editingId.value);
	if (existing) {
		draft.value = cloneContractValue(existing);
	}
	else {
		const slotId = randomUuid();
		draft.value = {
			id: randomUuid(),
			name: 'New daily template',
			period: 'day',
			defaultFiller: null,
			slots: [
				{
					id: slotId,
					startSeconds: 0,
					programId: programs.value[0]?.id ?? null,
					stateScope: 'persistent',
					startEligibility: { type: 'require-fit' },
					filler: programs.value[0] ? { mode: 'inherit' } : { mode: 'disabled' },
				},
			],
			boundaries: [
				{
					id: randomUuid(),
					leftSlotId: slotId,
					rightSlotId: slotId,
					targetSeconds: SECONDS_PER_SCHEDULING_DAY,
					policy: 'hard',
					maxDriftSeconds: 0,
					fallback: 'reject-start',
				},
			],
		};
	}
	selectedSlotId.value = draft.value.slots[0]?.id ?? '';
	for (const boundary of draft.value.boundaries) {
		if (boundary.maxDriftSeconds !== null) {
			finiteBoundaryDrift.set(boundary.id, boundary.maxDriftSeconds);
		}
	}
	assignedChannelIds.value = (scheduling.overview?.channelSchedules ?? [])
		.filter(
			(schedule) =>
				schedule.defaultTemplateId === draft.value?.id
				|| schedule.layers.some((layer) => layer.templateId === draft.value?.id),
		)
		.map((schedule) => schedule.channelId);
	preview.value = null;
	previewStale.value = false;
	originalSnapshot.value = snapshot();
}

/** Mark the materialized preview stale after authored settings change. */
function markChanged(): void {
	previewStale.value = preview.value !== null;
}

/** Describe placement for display or diagnostics. */
function placementDescription(placement: SlotPlacement): string {
	const slot = draft.value?.slots.find((entry) => entry.id === placement.slotId);
	return `${slot ? programName(slot.programId) : 'Missing slot'} at ${timeLabel(placement.splitSeconds)}`;
}

/** Leave slot-placement mode and optionally announce the cancellation. */
function cancelSlotPlacement(announce = true): void {
	addingSlot.value = false;
	slotPlacement.value = null;
	if (announce) {
		placementAnnouncement.value = 'Slot addition canceled.';
	}
}

/** Enter keyboard- and pointer-driven slot placement mode. */
async function beginSlotPlacement(): Promise<void> {
	if (!draft.value || !canAddSlot.value) {
		return;
	}

	if (addingSlot.value) {
		cancelSlotPlacement();
		return;
	}

	editorView.value = 'timeline';
	slotPlacement.value
		= midpointSlotPlacement(draft.value, selectedSlotId.value) ?? splittablePlacements.value[0]!;
	addingSlot.value = true;
	placementAnnouncement.value = `Choose where to add a slot. Current position: ${placementDescription(slotPlacement.value)}.`;
	await nextTick();
	timelineEditor.value?.timelineBar?.focus();
}

/** Split the selected slot at the proposed nominal time. */
function confirmSlotPlacement(placement = slotPlacement.value): void {
	if (!draft.value || !placement) {
		return;
	}

	const previousIds = new Set(draft.value.slots.map((slot) => slot.id));
	const updated = splitScheduleSlot(draft.value, placement.slotId, placement.splitSeconds);
	const added = updated.slots.find((slot) => !previousIds.has(slot.id));
	if (!added) {
		return;
	}

	draft.value = { ...updated, id: draft.value.id };
	selectedSlotId.value = added.id;
	addingSlot.value = false;
	slotPlacement.value = null;
	placementAnnouncement.value = `Added a slot starting at ${timeLabel(placement.splitSeconds)}.`;
	markChanged();
}

/** Convert a pointer position into seconds within the nominal day. */
function secondsFromTimelineClientX(clientX: number): number | null {
	if (!timelineEditor.value?.timelineBar) {
		return null;
	}

	const rect = timelineEditor.value?.timelineBar.getBoundingClientRect();
	if (clientX < rect.left || clientX > rect.right || rect.width <= 0) {
		return null;
	}

	return ((clientX - rect.left) / rect.width) * SECONDS_PER_SCHEDULING_DAY;
}

/** Project a pointer position onto the nearest valid slot split. */
function updateSlotPlacementFromPointer(event: PointerEvent | MouseEvent): void {
	if (!addingSlot.value || !draft.value) {
		return;
	}

	const seconds = secondsFromTimelineClientX(event.clientX);
	slotPlacement.value = seconds === null ? null : timelineSlotPlacement(draft.value, seconds);
}

/** Select a slot normally, or confirm the proposed split while placement mode is active. */
function handleSlotClick(event: MouseEvent, slot: ScheduleSlot): void {
	if (!addingSlot.value) {
		selectedSlotId.value = slot.id;
		return;
	}

	updateSlotPlacementFromPointer(event);
	confirmSlotPlacement();
}

/** Move keyboard placement to the previous or next splittable slot. */
function cyclePlacementSlot(direction: -1 | 1): void {
	if (!slotPlacement.value || splittablePlacements.value.length === 0) {
		return;
	}

	const index = splittablePlacements.value.findIndex(
		(placement) => placement.slotId === slotPlacement.value?.slotId,
	);
	const nextIndex
		= (Math.max(0, index) + direction + splittablePlacements.value.length)
			% splittablePlacements.value.length;
	slotPlacement.value = splittablePlacements.value[nextIndex]!;
	placementAnnouncement.value = `Current position: ${placementDescription(slotPlacement.value)}.`;
}

/** Move keyboard placement by one snapped interval within the current slot. */
function moveSlotPlacement(direction: -1 | 1): void {
	if (!draft.value || !slotPlacement.value) {
		return;
	}

	const next = slotPlacementForTime(
		draft.value,
		slotPlacement.value.slotId,
		slotPlacement.value.splitSeconds + direction * SLOT_PLACEMENT_STEP_SECONDS,
	);
	if (next) {
		slotPlacement.value = next;
		placementAnnouncement.value = `Current position: ${placementDescription(next)}.`;
	}
}

/** Support cancel, confirm, time adjustment, and slot cycling during keyboard placement. */
function handlePlacementKeydown(event: KeyboardEvent): void {
	if (!addingSlot.value) {
		return;
	}

	if (event.key === 'Escape') {
		event.preventDefault();
		cancelSlotPlacement();
	}
	else if (event.key === 'Enter' && slotPlacement.value) {
		event.preventDefault();
		confirmSlotPlacement();
	}
	else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
		event.preventDefault();
		moveSlotPlacement(event.key === 'ArrowLeft' ? -1 : 1);
	}
	else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
		event.preventDefault();
		cyclePlacementSlot(event.key === 'ArrowUp' ? -1 : 1);
	}
}

/** Switch between timeline and list views, cancelling placement when necessary. */
function setEditorView(view: 'timeline' | 'list'): void {
	if (view === 'list' && addingSlot.value) {
		cancelSlotPlacement();
	}
	editorView.value = view;
}

/** Remove the selected slot, expand its neighbor, and select the nearest remaining slot. */
function deleteSelected(): void {
	if (!draft.value || draft.value.slots.length <= 1) {
		return;
	}

	cancelSlotPlacement(false);
	const currentIndex = sortedSlots.value.findIndex((slot) => slot.id === selectedSlotId.value);
	const updated = deleteScheduleSlot(draft.value, selectedSlotId.value);
	draft.value = { ...updated, id: draft.value.id };
	selectedSlotId.value = updated.slots[Math.max(0, currentIndex - 1)]?.id ?? updated.slots[0]!.id;
	markChanged();
}

/** Move the boundary before a slot to a valid parsed nominal time. */
function changeStart(slot: ScheduleSlot, value: string): void {
	if (!draft.value) {
		return;
	}

	const seconds = parseTime(value);
	if (seconds === null) {
		return;
	}

	draft.value = { ...moveScheduleBoundary(draft.value, slot.id, seconds), id: draft.value.id };
	markChanged();
}

let draggedRightSlot = '';
/** Capture pointer movement for the boundary immediately before a slot. */
function startBoundaryDrag(event: PointerEvent, rightSlotId: string): void {
	if (addingSlot.value) {
		return;
	}

	draggedRightSlot = rightSlotId;
	(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

/** Snap the dragged boundary to a 15-minute position within the nominal day. */
function dragBoundary(event: PointerEvent): void {
	if (!draggedRightSlot || !draft.value || !timelineEditor.value?.timelineBar) {
		return;
	}

	const rect = timelineEditor.value?.timelineBar.getBoundingClientRect();
	const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
	const seconds = Math.round((ratio * SECONDS_PER_SCHEDULING_DAY) / 900) * 900;
	draft.value = {
		...moveScheduleBoundary(draft.value, draggedRightSlot, seconds),
		id: draft.value.id,
	};
	markChanged();
}

/** Finish the active template-boundary drag interaction. */
function endBoundaryDrag(): void {
	draggedRightSlot = '';
}

/** Merge authored behavior into the selected boundary and mark the preview stale. */
function updateBoundary(update: Partial<ScheduleBoundary>): void {
	if (!draft.value || !selectedBoundary.value) {
		return;
	}

	draft.value.boundaries = draft.value.boundaries.map((boundary) =>
		boundary.id === selectedBoundary.value?.id ? { ...boundary, ...update } : boundary);
	markChanged();
}

/** Change boundary policy while restoring a finite drift for policies that require one. */
function updateBoundaryPolicy(policy: ScheduleBoundary['policy']): void {
	if (!selectedBoundary.value) {
		return;
	}

	const maxDriftSeconds
		= policy !== 'finish-left' && selectedBoundary.value.maxDriftSeconds === null
			? (finiteBoundaryDrift.get(selectedBoundary.value.id) ?? 0)
			: selectedBoundary.value.maxDriftSeconds;
	updateBoundary({ policy, maxDriftSeconds });
}

/** Store a finite maximum drift in seconds for the selected boundary. */
function updateBoundaryDrift(minutes: number): void {
	if (!selectedBoundary.value) {
		return;
	}

	const maxDriftSeconds = minutes * 60;
	finiteBoundaryDrift.set(selectedBoundary.value.id, maxDriftSeconds);
	updateBoundary({ maxDriftSeconds });
}

/** Switch between unlimited drift and the selected boundary's last finite limit. */
function toggleUnlimitedBoundaryDrift(unlimited: boolean): void {
	if (!selectedBoundary.value) {
		return;
	}

	if (unlimited) {
		if (selectedBoundary.value.maxDriftSeconds !== null) {
			finiteBoundaryDrift.set(selectedBoundary.value.id, selectedBoundary.value.maxDriftSeconds);
		}
		updateBoundary({ maxDriftSeconds: null });
		return;
	}

	updateBoundary({
		maxDriftSeconds: finiteBoundaryDrift.get(selectedBoundary.value.id) ?? 0,
	});
}

/** Replace start eligibility and supply the default tolerance required by drift mode. */
function updateStartEligibility(type: ScheduleSlot['startEligibility']['type']): void {
	if (!selectedSlot.value) {
		return;
	}

	selectedSlot.value.startEligibility
		= type === 'within-drift' ? { type, maxDriftSeconds: 15 * 60 } : { type };
	markChanged();
}

/** Apply inherited, disabled, or configured filler with a valid default program. */
function updateSlotFiller(mode: ScheduleSlot['filler']['mode']): void {
	if (!selectedSlot.value) {
		return;
	}

	const programId = programs.value[0]?.id;
	if (mode === 'configured' && programId) {
		selectedSlot.value.filler = {
			mode,
			config: { programId, policy: 'best-fit-or-truncate' },
		};
	}
	else {
		selectedSlot.value.filler = mode === 'disabled' ? { mode } : { mode: 'inherit' };
	}
	markChanged();
}

/** Keep filler configuration valid when a slot changes between programmed and fall-through. */
function updateSlotProgram(): void {
	if (!selectedSlot.value) {
		return;
	}

	if (selectedSlot.value.programId === null) {
		selectedSlot.value.filler = { mode: 'disabled' };
	}
	else if (selectedSlot.value.filler.mode === 'disabled') {
		selectedSlot.value.filler = { mode: 'inherit' };
	}
	markChanged();
}

/** Enable default filler with the first program, or remove the template default. */
function toggleTemplateFiller(enabled: boolean): void {
	if (!draft.value) {
		return;
	}

	const programId = programs.value[0]?.id;
	draft.value.defaultFiller
		= enabled && programId ? { programId, policy: 'best-fit-or-truncate' } : null;
	markChanged();
}

/** Validate and save the template draft. */
async function save(): Promise<void> {
	if (!draft.value) {
		return;
	}

	saving.value = true;
	error.value = '';
	try {
		const body: ScheduleTemplateCreate = {
			name: draft.value.name,
			period: draft.value.period,
			defaultFiller: draft.value.defaultFiller,
			slots: draft.value.slots,
			boundaries: draft.value.boundaries,
		};
		const saved = editingId.value
			? await api.updateScheduleTemplate(editingId.value, body)
			: await api.createScheduleTemplate(body);
		await scheduling.load();
		if (props.embedded) {
			emit('saved', saved.id);
			return;
		}

		if (!editingId.value) {
			await router.replace(`/schedules/templates/${saved.id}`);
		}
		loadDraft();
		refreshPreviewNow();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		saving.value = false;
	}
}

/** Close the editor after confirming an embedded unsaved draft may be discarded. */
async function closeEditor(): Promise<void> {
	if (props.embedded) {
		if (isDirty.value && !(await requestConfirmation({
			key: `discard-embedded-template:${editingId.value ?? 'new'}`,
			title: 'Discard Unsaved Changes?',
			message: 'Close this template without saving your changes?',
			confirmLabel: 'Discard Changes',
			destructive: true,
		}))) {
			return;
		}

		emit('close');
		return;
	}

	void router.push('/schedules/templates');
}

let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewRevision = 0;

/** Cancel the pending coalesced preview request. */
function clearPreviewTimer(): void {
	if (previewTimer !== undefined) {
		clearTimeout(previewTimer);
		previewTimer = undefined;
	}
}

/** Validate and materialize the current draft unless a newer preview superseded it. */
async function generatePreview(revision: number): Promise<void> {
	if (!draft.value || revision !== previewRevision) {
		return;
	}

	previewQueued.value = false;
	previewing.value = true;
	previewError.value = '';
	try {
		const input = timelineDraftPreviewSchema.parse({
			template: draft.value,
			days: 1,
		});
		const generated = await api.draftTimelinePreview(input);
		if (revision !== previewRevision) {
			return;
		}

		preview.value = generated;
		previewStale.value = false;
	}
	catch (cause) {
		if (revision === previewRevision) {
			previewError.value = errorMessage(cause);
		}
	}
	finally {
		if (revision === previewRevision) {
			previewing.value = false;
		}
	}
}

/** Coalesce template changes before requesting a new resolved preview. */
function requestPreview(delay = PREVIEW_UPDATE_DELAY_MS): void {
	previewRevision += 1;
	const revision = previewRevision;
	clearPreviewTimer();
	if (!draft.value) {
		previewQueued.value = false;
		previewing.value = false;
		return;
	}

	previewStale.value = preview.value !== null;
	previewQueued.value = true;
	previewError.value = '';
	previewTimer = setTimeout(() => {
		previewTimer = undefined;
		void generatePreview(revision);
	}, delay);
}

/** Cancel any pending preview debounce and regenerate immediately. */
function refreshPreviewNow(): void {
	previewRevision += 1;
	const revision = previewRevision;
	clearPreviewTimer();
	if (!draft.value) {
		previewQueued.value = false;
		previewing.value = false;
		return;
	}

	previewStale.value = preview.value !== null;
	previewQueued.value = false;
	void generatePreview(revision);
}

/** Open the selected slot program in the embedded quick editor. */
function editProgram(programId: string | null): void {
	if (programId) {
		quickEditingProgramId.value = programId;
	}
}

/** Close the quick program editor and immediately refresh the resolved preview. */
function finishProgramEdit(): void {
	quickEditingProgramId.value = null;
	requestPreview(0);
}

/** Warn before navigation when the current editor contains unsaved changes. */
function beforeUnload(event: BeforeUnloadEvent): void {
	if (isDirty.value) {
		event.preventDefault();
	}
}

/** Close the active template editor with Escape when no nested editor owns the event. */
function handleEditorKeydown(event: KeyboardEvent): void {
	if (
		!event.defaultPrevented
		&& editing.value
		&& !quickEditingProgramId.value
		&& event.key === 'Escape'
	) {
		event.preventDefault();
		if (props.embedded) {
			event.stopImmediatePropagation();
			void closeEditor();
		}
		else {
			void router.push('/schedules/templates');
		}
	}
}

onBeforeRouteLeave(async () => {
	if (props.embedded) {
		return true;
	}

	if (!isDirty.value || await requestConfirmation({
		key: `discard-template:${editingId.value ?? 'new'}`,
		title: 'Discard Unsaved Changes?',
		message: 'Leave this template without saving your changes?',
		confirmLabel: 'Discard Changes',
		destructive: true,
	})) {
		return true;
	}

	return false;
});
watch([() => route.params.id, () => props.templateId], () => {
	loadDraft();
	refreshPreviewNow();
});
watch(previewDraftFingerprint, () => requestPreview(), {
	flush: 'sync',
});
onMounted(async () => {
	window.addEventListener('beforeunload', beforeUnload);
	document.addEventListener('keydown', handleEditorKeydown);

	try {
		await Promise.all([
			scheduling.load(),
			channelsStore.loadChannels(),
			capabilitiesLoaded.value ? Promise.resolve() : channelsStore.loadCapabilities(),
		]);
		loadDraft();
		refreshPreviewNow();
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		initialLoading.value = false;
	}
});
onBeforeUnmount(() => {
	window.removeEventListener('beforeunload', beforeUnload);
	document.removeEventListener('keydown', handleEditorKeydown);
	previewRevision += 1;
	clearPreviewTimer();
});
</script>

<template>
	<section>
		<div
			v-if="editing && !draft"
			class="moirai-dialog-backdrop"
			:class="{ 'nested-modal-backdrop': embedded, 'standalone-editor-backdrop': !embedded }"
			@click.self="closeEditor"
		>
			<div class="moirai-dialog scheduling-workspace-modal template-workspace" role="dialog" aria-modal="true" aria-label="Template editor">
				<LoadingState label="Loading template editor…" />
			</div>
		</div>
		<div
			v-else-if="editing && draft"
			class="moirai-dialog-backdrop"
			:class="{ 'nested-modal-backdrop': embedded, 'standalone-editor-backdrop': !embedded }"
			@click.self="closeEditor"
		>
			<div
				class="moirai-dialog scheduling-workspace-modal template-workspace"
				role="dialog"
				aria-modal="true"
				aria-label="Template editor"
			>
				<section class="template-toolbar editor-surface">
					<label>
						<span>Template name</span>
						<input v-model="draft.name" aria-label="Template name" autocapitalize="words" @input="markChanged" />
					</label>
					<span v-if="isDirty" class="draft-badge">Unsaved changes</span>
					<div class="template-toolbar-actions">
						<button type="button" class="toolbar-button" @click="closeEditor">Close</button>
						<button class="button" :disabled="saving" @click="save">
							{{ saving ? 'Saving…' : 'Save Template' }}
						</button>
					</div>
				</section>

				<div class="scheduling-workspace-scroll">
					<TemplateTimelineEditor
						ref="timelineEditor"
						v-model:selected-slot-id="selectedSlotId"
						:draft="draft"
						:sorted-slots="sortedSlots"
						:editor-view="editorView"
						:adding-slot="addingSlot"
						:slot-placement="slotPlacement"
						:placement-style="placementStyle"
						:used-programs="usedPrograms"
						:can-add-slot="canAddSlot"
						:placement-announcement="placementAnnouncement"
						:program-name="programName"
						:time-label="timeLabel"
						:slot-end="slotEnd"
						:slot-duration-label="slotDurationLabel"
						@begin-slot-placement="beginSlotPlacement"
						@set-editor-view="setEditorView"
						@pointer-move="addingSlot ? updateSlotPlacementFromPointer($event) : dragBoundary($event)"
						@pointer-up="endBoundaryDrag"
						@placement-keydown="handlePlacementKeydown"
						@slot-click="handleSlotClick"
						@boundary-pointer-down="startBoundaryDrag"
					/>

					<section v-if="selectedSlot" class="slot-inspector editor-surface">
						<div class="slot-inspector-main">
							<div class="template-panel-heading">
								<div>
									<p class="eyebrow">Selected slot</p>
									<div class="selected-slot-title">
										<h2>
											{{ timeLabel(selectedSlot.startSeconds) }} –
											{{ timeLabel(slotEnd(selectedSlot)) }}
										</h2>
										<span>{{ slotDurationLabel(selectedSlot) }}</span>
									</div>
								</div>
								<div class="card-actions">
									<button
										class="template-delete-button"
										:disabled="draft.slots.length <= 1"
										aria-label="Delete selected slot"
										@click="deleteSelected"
									>
										<Trash2 :size="17" />
									</button>
								</div>
							</div>
							<div class="template-slot-fields">
								<label>
									<span>Program</span>
									<span class="template-program-control">
										<span class="template-input-with-icon">
											<Monitor :size="17" />
											<select v-model="selectedSlot.programId" @change="updateSlotProgram">
												<option :value="null">No program — fall through</option>
												<option v-for="program in programs" :key="program.id" :value="program.id">
													{{ program.name }}
												</option>
											</select>
										</span>
										<button
											v-if="selectedSlot.programId"
											type="button"
											class="template-edit-program-button"
											:aria-label="`Edit ${programName(selectedSlot.programId)}`"
											@click="editProgram(selectedSlot.programId)"
										>
											<Pencil :size="16" />Edit
										</button>
									</span>
								</label>
								<label>
									<span>Starts</span>
									<span class="template-input-with-icon">
										<Clock3 :size="17" />
										<input
											type="time"
											:value="timeLabel(selectedSlot.startSeconds)"
											:disabled="selectedSlot.startSeconds === 0"
											@change="
												changeStart(selectedSlot, ($event.target as HTMLInputElement).value)
											"
										/>
									</span>
								</label>
							</div>
						</div>
						<AnimatedDisclosure
							v-if="selectedSlot.programId !== null"
							v-model="advancedOpen"
							class="slot-advanced"
						>
							<template #summary><span>Advanced scheduling behavior</span></template>
							<div class="form-grid">
								<label
								><span>Playback state</span
								><select v-model="selectedSlot.stateScope" @change="markChanged">
									<option value="persistent">Continue persistently</option>
									<option value="occurrence">Restart each day</option>
								</select></label
								><label
								><span>Item start rule</span
								><select
									:value="selectedSlot.startEligibility.type"
									@change="
										updateStartEligibility(
											($event.target as HTMLSelectElement)
												.value as ScheduleSlot['startEligibility']['type'],
										)
									"
								>
									<option value="require-fit">Require complete fit</option>
									<option value="allow-truncate">Allow truncation</option>
									<option value="allow-overrun">Allow overrun</option>
									<option value="within-drift">Within drift</option>
								</select></label
								><label v-if="selectedSlot.startEligibility.type === 'within-drift'"
								><span>Start drift (minutes)</span
								><input
									:value="selectedSlot.startEligibility.maxDriftSeconds / 60"
									type="number"
									min="0"
									max="1440"
									@input="
										selectedSlot.startEligibility.maxDriftSeconds =
											Number(($event.target as HTMLInputElement).value) * 60;
										markChanged();
									"
								/></label>
							</div>
							<fieldset v-if="selectedBoundary">
								<legend>
									Outgoing boundary at {{ timeLabel(selectedBoundary.targetSeconds) }}
								</legend>
								<div class="form-grid">
									<label
									><span>Policy</span
									><select
										:value="selectedBoundary.policy"
										@change="
											updateBoundaryPolicy(
												($event.target as HTMLSelectElement)
													.value as ScheduleBoundary['policy'],
											)
										"
									>
										<option value="hard">Hard boundary</option>
										<option value="finish-left">Finish left item</option>
										<option value="favor-right">Favor right slot</option>
									</select></label
									><label
									><span>Maximum drift (minutes)</span
									><input
										type="number"
										min="0"
										max="1440"
										:disabled="selectedBoundary.maxDriftSeconds === null"
										:value="(selectedBoundary.maxDriftSeconds ?? 0) / 60"
										@input="
											updateBoundaryDrift(Number(($event.target as HTMLInputElement).value))
										" /></label
									><label
										v-if="selectedBoundary.policy === 'finish-left'"
										class="check-row boundary-unlimited-control"
									><input
										type="checkbox"
										:checked="selectedBoundary.maxDriftSeconds === null"
										@change="
											toggleUnlimitedBoundaryDrift(($event.target as HTMLInputElement).checked)
										"
									/><span>No limit — always finish outgoing item</span></label
									><label
									><span>Fallback</span
									><select
										:disabled="selectedBoundary.maxDriftSeconds === null"
										:value="selectedBoundary.fallback"
										@change="
											updateBoundary({
												fallback: ($event.target as HTMLSelectElement)
													.value as ScheduleBoundary['fallback'],
											})
										"
									>
										<option value="reject-start">Reject item start</option>
										<option value="truncate-left">Truncate left item</option>
									</select></label
									>
								</div>
							</fieldset>
							<fieldset>
								<legend>Filler</legend>
								<label
								><span>Mode</span
								><select
									:value="selectedSlot.filler.mode"
									@change="
										updateSlotFiller(
											($event.target as HTMLSelectElement)
												.value as ScheduleSlot['filler']['mode'],
										)
									"
								>
									<option value="inherit">Inherit template/channel</option>
									<option value="disabled">Disabled</option>
									<option value="configured">Slot override</option>
								</select></label
								>
								<div v-if="selectedSlot.filler.mode === 'configured'" class="form-grid">
									<label>
										<span>Program</span>
										<span class="template-program-control">
											<select
												v-model="selectedSlot.filler.config.programId"
												@change="markChanged"
											>
												<option v-for="program in programs" :key="program.id" :value="program.id">
													{{ program.name }}
												</option>
											</select>
											<button
												type="button"
												class="template-edit-program-button"
												:aria-label="`Edit ${programName(selectedSlot.filler.config.programId)}`"
												@click="editProgram(selectedSlot.filler.config.programId)"
											>
												<Pencil :size="16" />Edit
											</button>
										</span> </label
									><label
									><span>Selection policy</span
									><select v-model="selectedSlot.filler.config.policy" @change="markChanged">
										<option value="best-fit-or-truncate">Best fit or truncate</option>
										<option value="best-fit-only">Best fit only</option>
										<option value="next-truncate">Next and truncate</option>
										<option value="next-fit-only">Next only if it fits</option>
									</select></label
									>
								</div>
							</fieldset>
							<fieldset>
								<legend>Template default filler</legend>
								<label class="check-row"
								><input
									type="checkbox"
									:checked="draft.defaultFiller !== null"
									@change="toggleTemplateFiller(($event.target as HTMLInputElement).checked)"
								/>Configure default filler</label
								>
								<div v-if="draft.defaultFiller" class="form-grid">
									<label>
										<span>Program</span>
										<span class="template-program-control">
											<select v-model="draft.defaultFiller.programId" @change="markChanged">
												<option v-for="program in programs" :key="program.id" :value="program.id">
													{{ program.name }}
												</option>
											</select>
											<button
												type="button"
												class="template-edit-program-button"
												:aria-label="`Edit ${programName(draft.defaultFiller.programId)}`"
												@click="editProgram(draft.defaultFiller.programId)"
											>
												<Pencil :size="16" />Edit
											</button>
										</span> </label
									><label
									><span>Selection policy</span
									><select v-model="draft.defaultFiller.policy" @change="markChanged">
										<option value="best-fit-or-truncate">Best fit or truncate</option>
										<option value="best-fit-only">Best fit only</option>
										<option value="next-truncate">Next and truncate</option>
										<option value="next-fit-only">Next only if it fits</option>
									</select></label
									>
								</div>
							</fieldset>
						</AnimatedDisclosure>
					</section>

					<TemplateAssignments :channels="assignedChannels" />
				</div>

				<ResolvedSchedulePreview
					:preview="preview"
					:stale="previewStale"
					:updating="previewing"
					:queued="previewQueued"
					:error="previewError"
					@refresh="refreshPreviewNow"
				/>
			</div>
		</div>
		<Teleport to="body">
			<ProgramsPage
				v-if="quickEditingProgramId"
				embedded
				:program-id="quickEditingProgramId"
				@close="quickEditingProgramId = null"
				@saved="finishProgramEdit"
			/>
		</Teleport>
	</section>
</template>
