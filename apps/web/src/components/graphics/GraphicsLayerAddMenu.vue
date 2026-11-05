<script setup lang="ts">
import { Clock3, Image, Plus, Shapes, Type } from '@lucide/vue';
import type { GraphicsLayer } from '@moirai/shared';
import { ref, useId } from 'vue';

defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ add: [kind: GraphicsLayer['kind']] }>();
const id = useId();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();

/** Layer types available when adding to the stack. */
const types = [
	{ kind: 'media', label: 'Add media', icon: Image },
	{ kind: 'text', label: 'Add text', icon: Type },
	{ kind: 'shape', label: 'Add shape', icon: Shapes },
	{ kind: 'clock', label: 'Add clock', icon: Clock3 },
] as const;

/** Open the menu beside its trigger and above any editor scroll area. */
function position(event: ToggleEvent): void {
	if (event.newState !== 'open' || !menu.value || !trigger.value) {
		return;
	}
	const bounds = trigger.value.getBoundingClientRect();
	menu.value.style.left = `${bounds.left}px`;
	menu.value.style.bottom = `${window.innerHeight - bounds.top + 4}px`;
	menu.value.style.maxHeight = `${Math.max(0, bounds.top - 12)}px`;
}

/** Restore focus to the plus button when closing an open menu. */
function close(event?: KeyboardEvent): void {
	if (menu.value?.matches(':popover-open')) {
		event?.stopPropagation();
		event?.preventDefault();
		menu.value.hidePopover();
		trigger.value?.focus({ preventScroll: true });
	}
}

/** Close before adding so focus has a stable target while the stack updates. */
function add(kind: GraphicsLayer['kind']): void {
	close();
	emit('add', kind);
}
</script>

<template>
	<div @keydown.esc="close">
		<button ref="trigger" type="button" class="button graphics-layer-tool" aria-label="Add layer" title="Add layer" :popovertarget="id" :disabled="disabled"><Plus :size="17" aria-hidden="true" /></button>
		<div :id="id" ref="menu" class="graphics-layer-add-menu" role="group" aria-label="Add layer" popover="auto" @beforetoggle="position">
			<button v-for="type in types" :key="type.kind" type="button" class="button secondary" @click="add(type.kind)"><component :is="type.icon" :size="16" aria-hidden="true" />{{ type.label }}</button>
		</div>
	</div>
</template>
