<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { X } from '@lucide/vue';
import type { GuideEntry, TimelineSegment } from '@moirai/shared';
import { guidePointerFraction, guideTimelineCrop } from '../guide-crop';
import { guideSourceLabel } from '../guide-source';
import { programColorStyle } from '../program-colors';

const props = withDefaults(defineProps<{ segments: TimelineSegment[]; timeZone: string; selectable?: boolean; programNames?: Record<string, string> }>(), { selectable: true, programNames: () => ({}) });
const emit = defineEmits<{ select: [segment: TimelineSegment] }>();
const panel = ref<HTMLElement>();
const entry = ref<GuideEntry | null>(null);
const fraction = ref(0.5);
let anchorBounds: DOMRect | null = null;
let frame: number | undefined;
let pointerX = 0;
let panelWidth = 640;
let visibleLeft = 8;
const manualDismissal = ref(false);
const markerPosition = ref({ left: '0px', top: '0px', height: '0px' });
const rangePositions = ref<Array<{ left: string; top: string; height: string }>>([]);
const position = ref({ left: '0px', top: '0px' });
let anchor: HTMLElement | null = null;
let restoringFocus = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const blockItems = computed(() => entry.value ? props.segments.filter((segment) =>
	segment.channelId === entry.value!.channelId && Date.parse(segment.start) < Date.parse(entry.value!.finish)
	&& Date.parse(segment.finish) > Date.parse(entry.value!.start)) : []);
const crop = computed(() => entry.value ? guideTimelineCrop(entry.value, blockItems.value, fraction.value) : null);

/** Format the full actual airtime in the configured guide zone, including its date. */
function time(value: string | number): string {
	return new Intl.DateTimeFormat(undefined, {
		month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: props.timeZone,
	}).format(new Date(value));
}

/** Keep the popover available while its items are being read or focused. */
function keepOpen(): void {
	clearTimeout(timer);
}

/** Dismiss the presentation without interfering with playback or selection. */
function close(restoreFocus = false): void {
	keepOpen();
	if (frame !== undefined) {
		cancelAnimationFrame(frame);
		frame = undefined;
	}
	entry.value = null;
	if (restoreFocus) {
		restoringFocus = true;
		(anchor?.querySelector('button') ?? anchor)?.focus();
		restoringFocus = false;
	}
}

/** Bridge the small pointer gap between a guide block and its floating content. */
function leave(): void {
	keepOpen();
	timer = setTimeout(() => {
		if (!panel.value?.contains(document.activeElement) && !anchor?.contains(document.activeElement)) {
			close();
		}
	}, 180);
}

/** Center the panel on the inspected time without measuring layout on pointer movement. */
function positionAt(clientX: number): void {
	if (!anchorBounds) {
		return;
	}
	const point = Math.max(visibleLeft, Math.min(clientX, window.innerWidth - 8));
	position.value = { ...position.value, left: `${Math.max(8, Math.min(point - panelWidth / 2, window.innerWidth - panelWidth - 8))}px` };
	markerPosition.value = { left: `${point}px`, top: `${anchorBounds.top}px`, height: `${anchorBounds.height}px` };
	const start = Date.parse(entry.value!.start);
	const duration = Date.parse(entry.value!.finish) - start;
	rangePositions.value = crop.value ? [crop.value.start, crop.value.finish].flatMap((time) => {
		const left = anchorBounds!.left + (time - start) / duration * anchorBounds!.width;
		return left >= visibleLeft && left <= window.innerWidth - 8
			? [{ left: `${left}px`, top: `${anchorBounds!.top}px`, height: `${anchorBounds!.height}px` }]
			: [];
	}) : [];
}

/** Measure the anchor and panel once; scrolling dismisses stale anchored coordinates. */
async function show(value: GuideEntry, target: HTMLElement, focus = false, clientX?: number): Promise<void> {
	if (restoringFocus) {
		return;
	}
	keepOpen();
	anchorBounds = target.getBoundingClientRect();
	fraction.value = clientX === undefined ? 0.5 : guidePointerFraction(clientX, anchorBounds.left, anchorBounds.width);
	entry.value = value;
	manualDismissal.value = focus || clientX === undefined;
	anchor = target;
	await nextTick();
	const bounds = anchorBounds;
	const channelCell = target.closest('.guide-channel-track')?.previousElementSibling;
	visibleLeft = Math.max(8, channelCell?.getBoundingClientRect().right ?? 8);
	panelWidth = panel.value?.getBoundingClientRect().width ?? 640;
	const height = panel.value?.getBoundingClientRect().height ?? 320;
	const below = bounds.bottom + 4;
	position.value = {
		left: position.value.left,
		top: `${below + height <= window.innerHeight - 8 ? below : Math.max(8, bounds.top - height - 4)}px`,
	};
	positionAt(clientX ?? bounds.left + bounds.width / 2);
	if (focus) {
		panel.value?.focus();
	}
}

/** Follow pointer movement with one reactive update per frame and no repeated layout measurements. */
function move(event: PointerEvent, value: GuideEntry): void {
	if (!entry.value || entry.value.id !== value.id || !anchorBounds) {
		void show(value, event.currentTarget as HTMLElement, false, event.clientX);
		return;
	}
	pointerX = event.clientX;
	if (frame === undefined) {
		frame = requestAnimationFrame(() => {
			frame = undefined;
			if (anchorBounds && entry.value) {
				fraction.value = guidePointerFraction(pointerX, anchorBounds.left, anchorBounds.width);
				positionAt(pointerX);
			}
		});
	}
}

/** Allow outside interactions and Escape to dismiss hover, keyboard, and touch presentations. */
function outside(event: Event): void {
	if (event.type === 'resize') {
		close();
		return;
	}

	if (event instanceof KeyboardEvent) {
		if (event.key === 'Escape' && entry.value) {
			event.stopPropagation();
			close(true);
		}
		if (['PageDown', 'PageUp', 'Home', 'End'].includes(event.key) && !panel.value?.contains(event.target as Node)) {
			close();
		}
		return;
	}
	if (!panel.value?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) {
		close();
	}
}

/** Invalidate cached anchor geometry when its ancestors scroll, but allow panel scrolling. */
function scrolled(event: Event): void {
	const target = event.target;
	if (entry.value && anchorBounds && target instanceof Node && anchor && target.contains(anchor) && !panel.value?.contains(target)) {
		// A queued scroll from before show() may already be reflected in the cached bounds.
		const bounds = anchor.getBoundingClientRect();
		if (bounds.left !== anchorBounds.left || bounds.top !== anchorBounds.top) {
			close();
		}
	}
}

onMounted(() => {
	document.addEventListener('scroll', scrolled, true);
	document.addEventListener('pointerdown', outside);
	document.addEventListener('keydown', outside, true);
	document.addEventListener('wheel', outside, { capture: true, passive: true });
	document.addEventListener('touchmove', outside, { capture: true, passive: true });
	window.addEventListener('resize', outside);
});
onBeforeUnmount(() => {
	close();
	document.removeEventListener('scroll', scrolled, true);
	document.removeEventListener('pointerdown', outside);
	document.removeEventListener('keydown', outside, true);
	document.removeEventListener('wheel', outside, true);
	document.removeEventListener('touchmove', outside, true);
	window.removeEventListener('resize', outside);
});
defineExpose({ show, move, leave, close });
</script>

<template>
	<Teleport to="body">
		<template v-if="entry">
			<span class="guide-position-marker" :style="markerPosition" aria-hidden="true"></span>
			<span v-for="(boundary, index) in rangePositions" :key="index" class="guide-range-marker" :style="boundary" aria-hidden="true"></span>
		</template>
		<section
			v-if="entry" ref="panel" class="guide-block-popover" :style="position"
			role="dialog" aria-label="Actual guide items" tabindex="-1"
			@pointerenter="keepOpen" @pointerleave="leave" @focusout="leave">
			<header><strong>{{ entry.title }}</strong>
				<button v-if="manualDismissal" type="button" class="icon-button" aria-label="Close guide items" @click="close(true)"><X :size="18" /></button>
			</header>
			<p>{{ time(entry.start) }} – {{ time(entry.finish) }}</p>
			<p v-if="entry.description">{{ entry.description }}</p>
			<div v-if="crop" class="guide-crop" :data-center="crop.center" :data-start="crop.start" :data-finish="crop.finish">
				<div class="guide-crop-ruler" aria-hidden="true">
					<span>{{ time(crop.start) }}</span><span>{{ time(crop.finish) }}</span>
				</div>
				<div class="guide-crop-track" role="group" aria-label="Actual items timeline">
					<component
						:is="selectable ? 'button' : 'div'" v-for="item in crop.items"
						:key="item.segment.id" :type="selectable ? 'button' : undefined"
						class="guide-programme" :class="[`role-${item.segment.role}`, { truncated: item.segment.truncated }]"
						:style="{ ...programColorStyle(item.segment.programId), left: `${item.left}%`, width: `${item.width}%` }"
						:title="`${item.segment.title} · ${time(item.segment.start)} – ${time(item.segment.finish)}`"
						:aria-label="`${item.segment.role === 'dead-air' ? 'No programming' : item.segment.title}, ${time(item.segment.start)} – ${time(item.segment.finish)}`"
						@click="selectable && (emit('select', item.segment), close())">
						<strong>{{ item.segment.role === 'dead-air' ? 'No programming' : item.segment.title }}</strong>
						<small>{{ guideSourceLabel(item.segment, programNames) }}<template v-if="item.segment.truncated"> · truncated</template></small>
					</component>
					<span class="guide-crop-range-marker range-start" aria-hidden="true"></span>
					<span class="guide-crop-range-marker range-end" aria-hidden="true"></span>
					<span class="guide-crop-marker" :style="{ left: `${crop.marker}%` }" aria-hidden="true"></span>
				</div>
			</div>
		</section>
	</Teleport>
</template>
