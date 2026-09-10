<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { captureDisclosureLayout, animateDisclosureLayout } from './form-disclosure-motion';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const expanded = ref(props.open);
const visible = ref(expanded.value);
const root = ref<HTMLElement>();
const content = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const surface = ref<HTMLElement>();
const contentId = useId();
let animations: Animation[] = [];
let revision = 0;

/** Release transient positioning after collapse or before a new layout is committed. */
function clearPosition(): void {
	if (content.value) {
		content.value.style.position = '';
		content.value.style.width = '';
	}
}

/** Commit the final layout once, then animate displaced sections and the presentation layers. */
async function setExpanded(value: boolean): Promise<void> {
	if (!root.value || !content.value || value === expanded.value) {
		return;
	}
	const currentRevision = ++revision;
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const before = captureDisclosureLayout(root.value);
	const height = root.value.getBoundingClientRect().height;
	const width = content.value.getBoundingClientRect().width;
	const opacity = visible.value ? getComputedStyle(content.value).opacity : '0';
	for (const animation of animations) {
		animation.cancel();
	}
	animations = [];
	if (!value && content.value.contains(document.activeElement)) {
		trigger.value?.focus({ preventScroll: true });
	}

	// Remove collapsed content from flow immediately while its outgoing layer fades away.
	clearPosition();
	if (!value && !reduced) {
		content.value.style.position = 'absolute';
		content.value.style.width = `${width}px`;
	}
	expanded.value = value;
	visible.value = value || !reduced;
	await nextTick();
	if (currentRevision !== revision || !root.value || !content.value) {
		return;
	}
	if (reduced) {
		return;
	}

	const styles = getComputedStyle(root.value);
	const timing = { duration: parseFloat(styles.getPropertyValue('--motion-system')) || 350,
		easing: styles.getPropertyValue('--motion-system-ease').trim() || 'ease-in-out' };
	animations = animateDisclosureLayout(before, timing);
	animations.push(content.value.animate([
		{ opacity, transform: value ? 'translateY(-8px)' : 'translateY(0)' },
		{ opacity: value ? 1 : 0, transform: value ? 'translateY(0)' : 'translateY(-8px)' },
	], timing));
	if (surface.value) {
		const finalHeight = root.value.getBoundingClientRect().height;
		animations.push(surface.value.animate([{ transform: `scaleY(${height / finalHeight})` }, { transform: 'scaleY(1)' }], timing));
	}
	await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
	if (currentRevision === revision) {
		visible.value = expanded.value;
		await nextTick();
		if (currentRevision === revision) {
			clearPosition();
			animations = [];
		}
	}
}

watch(() => props.open, (value) => {
	void setExpanded(value);
});
onBeforeUnmount(() => {
	revision++;
	for (const animation of animations) {
		animation.cancel();
	}
});
</script>

<template>
	<div ref="root" class="form-disclosure" :class="{ 'is-open': expanded }">
		<div ref="surface" class="form-disclosure-surface" aria-hidden="true" />
		<button ref="trigger" class="form-disclosure-trigger" type="button" :aria-expanded="expanded" :aria-controls="contentId" @click="emit('update:open', !expanded)">
			<slot name="summary" />
		</button>
		<div v-show="visible" :id="contentId" ref="content" class="form-disclosure-content" :inert="!expanded" :aria-hidden="!expanded">
			<slot />
		</div>
	</div>
</template>
