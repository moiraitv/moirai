<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue';
import { CircleAlert } from '@lucide/vue';
import { useRoute } from 'vue-router';
import type { TimelineIssue } from '@moirai/shared';
import { countLabel } from '../count-label';
import { viewportTooltipPosition } from '../viewport-tooltip';

const props = withDefaults(defineProps<{
	issues: TimelineIssue[];
	limit?: number;
}>(), { limit: 3 });
const route = useRoute();
const trigger = ref<HTMLElement>();
const tooltip = ref<HTMLElement>();
const visible = ref(false);
const pinned = ref(false);
const position = ref({ left: 12, top: 12 });
const tooltipId = useId();
const warningOpenEvent = 'moirai-schedule-warning-open';

const displayedMessages = computed(() => {
	const messages = [...new Set(props.issues.map((issue) => issue.message))];
	return messages.slice(0, Math.max(1, props.limit));
});
const omittedCount = computed(() => Math.max(0, props.issues.length - displayedMessages.value.length));
const label = computed(() => countLabel(props.issues.length, 'warning'));

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
	document.dispatchEvent(new CustomEvent(warningOpenEvent, { detail: tooltipId }));
	pinned.value = keepOpen;
	visible.value = true;
	void nextTick().then(updatePosition);
}

/** Dismiss the warning list unless a direct interaction pinned it. */
function hide(force = false): void {
	if (pinned.value && !force) {
		return;
	}

	pinned.value = false;
	visible.value = false;
}

/** Reveal warnings only for pointers that support intentional hover. */
function handlePointerEnter(event: PointerEvent): void {
	if (event.pointerType === 'mouse' && supportsHover()) {
		show();
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

/** Close a pinned tooltip when another part of the document receives a pointer press. */
function handleDocumentPointer(event: PointerEvent): void {
	if (pinned.value && event.target instanceof Node && !trigger.value?.contains(event.target)) {
		hide(true);
	}
}

/** Close through Escape without changing focus. */
function handleKeydown(event: KeyboardEvent): void {
	if (event.key === 'Escape' && visible.value) {
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
		@pointerleave="hide()"
		@focus="show(pinned)"
		@blur="hide()"
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
				role="tooltip"
				:style="{ left: `${position.left}px`, top: `${position.top}px` }"
			>
				<strong>Scheduling warnings</strong>
				<ul>
					<li v-for="message in displayedMessages" :key="message">{{ message }}</li>
				</ul>
				<small v-if="omittedCount">{{ countLabel(omittedCount, 'additional warning') }}</small>
			</aside>
		</Transition>
	</Teleport>
</template>
