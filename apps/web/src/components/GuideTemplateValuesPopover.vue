<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue';
import { X } from '@lucide/vue';
import type { GuideTemplatePreviewValue } from '@moirai/shared';

const props = defineProps<{
	title: string;
	values: GuideTemplatePreviewValue[];
}>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>();
const visible = ref(false);
const teleportTarget = ref<HTMLElement | string>('body');
const position = ref({ left: '0px', top: '0px' });
let anchor: HTMLElement | null = null;

/** Keep the panel inside the viewport, preferring space below the listing. */
function place(): void {
	if (!anchor || !panel.value) {
		return;
	}

	const bounds = anchor.getBoundingClientRect();
	const width = panel.value.getBoundingClientRect().width;
	const height = panel.value.getBoundingClientRect().height;
	const left = Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8));
	const below = bounds.bottom + 8;
	const top = below + height <= window.innerHeight - 8
		? below
		: Math.max(8, bounds.top - height - 8);
	position.value = { left: `${left}px`, top: `${top}px` };
}

/** Dismiss on outside pointer or Escape without closing the template editor. */
function onDocumentEvent(event: Event): void {
	if (!visible.value) {
		return;
	}
	if (event instanceof KeyboardEvent && event.key === 'Escape') {
		event.stopPropagation();
		event.preventDefault();
		close(true);
		return;
	}
	if (event.type === 'pointerdown') {
		const target = event.target;
		if (target instanceof Node && (panel.value?.contains(target) || anchor?.contains(target))) {
			return;
		}
		close();
	}
	if (event.type === 'resize' || event.type === 'scroll') {
		place();
	}
}

/** Anchor the popover to a preview listing or channel cell. */
async function show(target: HTMLElement): Promise<void> {
	anchor = target;
	teleportTarget.value = target.closest<HTMLElement>('.moirai-dialog-backdrop') ?? 'body';
	visible.value = true;
	await nextTick();
	place();
	panel.value?.focus();
}

/** Hide the popover and optionally restore focus to the listing. */
function close(restoreFocus = false): void {
	if (!visible.value) {
		return;
	}

	visible.value = false;
	if (restoreFocus) {
		anchor?.focus();
	}
	anchor = null;
	emit('close');
}

document.addEventListener('pointerdown', onDocumentEvent, true);
document.addEventListener('keydown', onDocumentEvent, true);
window.addEventListener('resize', onDocumentEvent);
window.addEventListener('scroll', onDocumentEvent, true);
onBeforeUnmount(() => {
	document.removeEventListener('pointerdown', onDocumentEvent, true);
	document.removeEventListener('keydown', onDocumentEvent, true);
	window.removeEventListener('resize', onDocumentEvent);
	window.removeEventListener('scroll', onDocumentEvent, true);
});
defineExpose({ show, close });
</script>

<template>
	<Teleport :to="teleportTarget">
		<section
			v-if="visible && values.length"
			ref="panel"
			class="guide-template-values-popover"
			role="dialog"
			aria-label="Liquid values"
			tabindex="-1"
			:style="position"
		>
			<header>
				<strong>{{ title }}</strong>
				<button class="icon-button" type="button" aria-label="Close values" @click="close(true)">
					<X :size="18" aria-hidden="true" />
				</button>
			</header>
			<dl>
				<div v-for="row in props.values" :key="row.name">
					<dt><code>{{ row.name }}</code></dt>
					<dd>{{ row.value }}</dd>
				</div>
			</dl>
		</section>
	</Teleport>
</template>
