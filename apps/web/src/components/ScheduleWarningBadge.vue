<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue';
import { CircleAlert } from '@lucide/vue';
import { useRoute } from 'vue-router';
import type { TimelineIssue } from '@moirai/shared';
import { countLabel } from '../count-label';
import { dateKey } from '../date-key';
import { distinctWarningIssues } from '../schedule-warning-issues';
import { viewportTooltipPosition } from '../viewport-tooltip';

const props = withDefaults(defineProps<{
	issues: TimelineIssue[];
	channelId?: string | undefined;
	timeZone?: string | undefined;
	limit?: number;
}>(), { channelId: undefined, timeZone: undefined, limit: 3 });
const route = useRoute();
const trigger = ref<HTMLElement>();
const tooltip = ref<HTMLElement>();
const visible = ref(false);
const pinned = ref(false);
const position = ref({ left: 12, top: 12 });
const tooltipId = useId();
const warningOpenEvent = 'moirai-schedule-warning-open';
/** Allow the pointer to cross the 12-pixel gap to the interactive warning panel. */
const CLOSE_DELAY_MS = 350;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let pointerInside = false;

const distinctIssues = computed(() => distinctWarningIssues(props.issues));
const displayedIssues = computed(() => distinctIssues.value.slice(0, Math.max(1, props.limit)));
const omittedCount = computed(() => Math.max(
	0,
	distinctIssues.value.length - displayedIssues.value.length,
));
const warningCount = computed(() => props.issues.reduce(
	(total, issue) => total + Math.max(1, issue.occurrenceCount ?? issue.occurrences?.length ?? 1),
	0,
));
const label = computed(() => countLabel(warningCount.value, 'warning'));
const diagnosticHref = computed(() => {
	if (!props.channelId) {
		return null;
	}

	const issue = props.issues.find((candidate) => candidate.occurrences?.length);
	const occurrence = issue?.occurrences?.[0];
	if (!issue || !occurrence) {
		return `/schedules/channels/${encodeURIComponent(props.channelId)}`;
	}

	const query = new URLSearchParams({
		previewDate: dateKey(
			new Date(occurrence.start),
			props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
		),
	});
	if (issue.scheduleLayerId) {
		query.set('layer', issue.scheduleLayerId);
	}
	if (occurrence.boundaryOrigin) {
		query.set('boundary', occurrence.boundaryOrigin);
	}
	return `/schedules/channels/${encodeURIComponent(props.channelId)}?${query.toString()}`;
});

/** Format the first exact occurrence represented by an aggregated warning. */
function occurrenceLabel(issue: TimelineIssue): string | null {
	const occurrence = issue.occurrences?.[0];
	if (!occurrence) {
		return null;
	}

	const timeZone = props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const formatter = new Intl.DateTimeFormat([], {
		timeZone,
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
	});
	const finish = occurrence.finish ? `–${formatter.format(new Date(occurrence.finish))}` : '';
	const additional = Math.max(0, (issue.occurrenceCount ?? issue.occurrences?.length ?? 1) - 1);
	return `${formatter.format(new Date(occurrence.start))}${finish}`
		+ (additional > 0 ? ` · ${countLabel(additional, 'more occurrence')}` : '');
}

/** Return whether this browser provides a conventional accurate hover pointer. */
function supportsHover(): boolean {
	return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/** Keep the teleported warning list beside its badge and inside the viewport. */
function updatePosition(): void {
	if (!trigger.value || !tooltip.value) {
		return;
	}

	const triggerBox = trigger.value.getBoundingClientRect();
	const tooltipBox = tooltip.value.getBoundingClientRect();
	position.value = viewportTooltipPosition({
		anchor: triggerBox,
		tooltipWidth: tooltipBox.width,
		tooltipHeight: tooltipBox.height,
		viewportWidth: window.innerWidth,
		viewportHeight: window.innerHeight,
	});
}

/** Reveal the warning list and optionally pin it for touch or pointer interaction. */
function show(keepOpen = false): void {
	cancelClose();
	document.dispatchEvent(new CustomEvent(warningOpenEvent, { detail: tooltipId }));
	pinned.value = keepOpen;
	visible.value = true;
	void nextTick().then(updatePosition);
}

/** Dismiss the warning list unless a direct interaction pinned it. */
function hide(force = false): void {
	cancelClose();
	if (!force && (pinned.value || pointerInside || containsTarget(document.activeElement))) {
		return;
	}

	pinned.value = false;
	visible.value = false;
}

/** Treat the trigger and its teleported panel as one interactive surface. */
function containsTarget(target: EventTarget | null): boolean {
	return target instanceof Node && Boolean(trigger.value?.contains(target) || tooltip.value?.contains(target));
}

/** Cancel a pending dismissal when pointer or focus returns to either surface. */
function cancelClose(): void {
	clearTimeout(closeTimer);
	closeTimer = undefined;
}

/** Delay dismissal across the gap without closing a focused or pinned panel. */
function scheduleClose(): void {
	cancelClose();
	closeTimer = setTimeout(() => hide(), CLOSE_DELAY_MS);
}

/** Reveal warnings only for pointers that support intentional hover. */
function handlePointerEnter(event: PointerEvent): void {
	if (event.pointerType === 'mouse' && supportsHover()) {
		pointerInside = true;
		show(pinned.value);
	}
}

/** Keep the panel open while the pointer transfers between its two surfaces. */
function handlePointerLeave(event: PointerEvent): void {
	pointerInside = containsTarget(event.relatedTarget);
	if (!pointerInside) {
		scheduleClose();
	}
}

/** Dismiss only after focus leaves both the trigger and the interactive panel. */
function handleFocusOut(event: FocusEvent): void {
	if (!containsTarget(event.relatedTarget)) {
		scheduleClose();
	}
}

/** Place the teleported action immediately after its trigger in keyboard navigation. */
function handleTriggerKeydown(event: KeyboardEvent): void {
	if (event.key === 'Tab' && !event.shiftKey && visible.value) {
		const link = tooltip.value?.querySelector<HTMLElement>('a');
		if (link) {
			event.preventDefault();
			link.focus();
		}
	}
}

/** Resume the trigger's logical tab order when leaving the teleported action. */
function handlePanelKeydown(event: KeyboardEvent): void {
	if (event.key !== 'Tab' || !trigger.value) {
		return;
	}

	if (event.shiftKey) {
		event.preventDefault();
	}
	trigger.value.focus({ preventScroll: true });
	if (!event.shiftKey) {
		// Native Tab advances from the restored badge, respecting hidden and disabled controls.
		hide(true);
	}
}

/** Toggle a persistent warning list without activating the surrounding channel row. */
function togglePinned(): void {
	if (pinned.value) {
		hide(true);
		return;
	}

	show(true);
}

/** Close warnings when another part of the document receives a pointer press. */
function handleDocumentPointer(event: PointerEvent): void {
	if (!containsTarget(event.target)) {
		hide(true);
	}
}

/** Close through Escape and return focus from the panel to its trigger. */
function handleKeydown(event: KeyboardEvent): void {
	if (event.key === 'Escape' && visible.value) {
		if (tooltip.value?.contains(document.activeElement)) {
			trigger.value?.focus();
		}
		hide(true);
	}
}

/** Ensure only one scheduling-warning tooltip remains visible. */
function handleOtherWarningOpen(event: Event): void {
	if (event instanceof CustomEvent && event.detail !== tooltipId) {
		hide(true);
	}
}

watch(visible, (isVisible) => {
	if (isVisible) {
		window.addEventListener('resize', updatePosition);
		window.addEventListener('scroll', updatePosition, true);
		document.addEventListener('pointerdown', handleDocumentPointer);
		document.addEventListener('keydown', handleKeydown);
		document.addEventListener(warningOpenEvent, handleOtherWarningOpen);
	}
	else {
		window.removeEventListener('resize', updatePosition);
		window.removeEventListener('scroll', updatePosition, true);
		document.removeEventListener('pointerdown', handleDocumentPointer);
		document.removeEventListener('keydown', handleKeydown);
		document.removeEventListener(warningOpenEvent, handleOtherWarningOpen);
	}
});
watch(() => route.fullPath, () => hide(true));
watch(
	() => [props.limit, ...props.issues.map((issue) => issue.message)],
	async () => {
		if (props.issues.length === 0) {
			hide(true);
			return;
		}

		if (visible.value) {
			await nextTick();
			updatePosition();
		}
	},
);
onUnmounted(() => {
	hide(true);
	window.removeEventListener('resize', updatePosition);
	window.removeEventListener('scroll', updatePosition, true);
	document.removeEventListener('pointerdown', handleDocumentPointer);
	document.removeEventListener('keydown', handleKeydown);
	document.removeEventListener(warningOpenEvent, handleOtherWarningOpen);
});
</script>

<template>
	<button
		v-if="issues.length"
		ref="trigger"
		type="button"
		class="schedule-warning-badge"
		:aria-label="`${label}; show details`"
		:aria-expanded="visible"
		:aria-describedby="visible ? tooltipId : undefined"
		@pointerenter="handlePointerEnter"
		@pointerleave="handlePointerLeave"
		@focus="show(pinned)"
		@blur="handleFocusOut"
		@keydown="handleTriggerKeydown"
		@click.stop="togglePinned"
	>
		<CircleAlert :size="13" />{{ label }}
	</button>
	<Teleport to="body">
		<Transition name="context-popover">
			<aside
				v-if="visible && issues.length"
				:id="tooltipId"
				ref="tooltip"
				class="schedule-warning-tooltip"
				role="dialog"
				aria-label="Scheduling warnings"
				:style="{ left: `${position.left}px`, top: `${position.top}px` }"
				@pointerenter="handlePointerEnter"
				@pointerleave="handlePointerLeave"
				@focusin="cancelClose"
				@focusout="handleFocusOut"
				@keydown="handlePanelKeydown"
			>
				<strong>Scheduling warnings</strong>
				<ul>
					<li
						v-for="issue in displayedIssues"
						:key="`${issue.slotId}:${issue.code}:${issue.programId}:${issue.mediaItemId}`"
					>
						<span>{{ issue.message }}</span>
						<small v-if="occurrenceLabel(issue)">{{ occurrenceLabel(issue) }}</small>
					</li>
				</ul>
				<small v-if="omittedCount">{{ countLabel(omittedCount, 'additional warning type') }}</small>
				<RouterLink v-if="diagnosticHref" class="schedule-warning-diagnose" :to="diagnosticHref">
					Diagnose schedule
				</RouterLink>
			</aside>
		</Transition>
	</Teleport>
</template>
