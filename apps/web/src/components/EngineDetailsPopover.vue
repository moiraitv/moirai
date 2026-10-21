<script setup lang="ts">
import { ChevronDown } from '@lucide/vue';
import { onBeforeUnmount, onMounted, ref, useId } from 'vue';

defineProps<{ version?: string | null | undefined; revision?: string | null | undefined }>();
const id = useId();
const panel = ref<HTMLElement | null>(null);
const expanded = ref(false);
const position = ref({ left: '0px', top: '0px' });
let anchor: HTMLElement | undefined;
let anchorBounds: DOMRect | undefined;

/** Place the native light-dismiss popup within the viewport without moving the status card. */
function toggle(event: MouseEvent): void {
	const popup = panel.value;
	if (!popup) {
		return;
	}
	if (popup.matches(':popover-open')) {
		popup.hidePopover();
		return;
	}

	anchor = event.currentTarget as HTMLElement;
	const trigger = anchor.getBoundingClientRect();
	anchorBounds = trigger;
	popup.showPopover();
	const bounds = popup.getBoundingClientRect();
	position.value = {
		left: `${Math.max(8, Math.min(trigger.right - bounds.width, window.innerWidth - bounds.width - 8))}px`,
		top: `${Math.max(8, trigger.bottom + bounds.height + 8 <= window.innerHeight ? trigger.bottom + 8 : trigger.top - bounds.height - 8)}px`,
	};
}

/** Keep the disclosure state in sync after outside interaction or Escape. */
function syncExpanded(event: Event): void {
	expanded.value = (event as ToggleEvent).newState === 'open';
}

/** Dismiss stale coordinates after scrolling, resizing, or rotating the device. */
function dismissOnViewportChange(event: Event): void {
	if (!panel.value?.matches(':popover-open')) {
		return;
	}
	if (event.type === 'scroll' && anchor && anchorBounds) {
		const current = anchor.getBoundingClientRect();
		// Ignore queued scroll events already accounted for when the trigger was positioned.
		if (current.left === anchorBounds.left && current.top === anchorBounds.top) {
			return;
		}
	}
	panel.value.hidePopover();
}

onMounted(() => {
	window.addEventListener('resize', dismissOnViewportChange);
	window.addEventListener('scroll', dismissOnViewportChange, true);
});
onBeforeUnmount(() => {
	window.removeEventListener('resize', dismissOnViewportChange);
	window.removeEventListener('scroll', dismissOnViewportChange, true);
});
</script>

<template>
	<button type="button" class="button secondary" :aria-expanded="expanded" :aria-controls="id" :aria-describedby="id" @click="toggle">Engine details<ChevronDown :size="17" aria-hidden="true" /></button>
	<aside :id="id" ref="panel" popover="auto" role="tooltip" class="settings-engine-details" :style="position" @toggle="syncExpanded">
		<template v-if="version"><strong>Engine details</strong><span>{{ version }}</span><code v-if="revision">{{ revision.slice(0, 12) }}</code></template>
		<span v-else>Engine details unavailable.</span>
	</aside>
</template>
