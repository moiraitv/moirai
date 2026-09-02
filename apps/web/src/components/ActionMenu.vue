<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
	label: string;
	triggerClass?: string;
	menuClass?: string;
}>(), {
	triggerClass: '',
	menuClass: '',
});

/** Document event used to keep only one action menu open at a time. */
const actionMenuOpenEvent = 'moirai-action-menu-open';
const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const open = ref(false);

/** Close the menu and optionally restore keyboard focus to its trigger. */
function close(restoreFocus = false): void {
	open.value = false;
	if (restoreFocus) {
		trigger.value?.focus();
	}
}

/** Toggle this menu and notify any other open menu to dismiss itself. */
function toggle(): void {
	open.value = !open.value;
	if (open.value) {
		document.dispatchEvent(new CustomEvent(actionMenuOpenEvent, { detail: root.value }));
	}
}

/** Dismiss the menu when a pointer interaction begins outside its complete surface. */
function handleDocumentPointer(event: PointerEvent): void {
	if (event.target instanceof Node && !root.value?.contains(event.target)) {
		close();
	}
}

/** Dismiss with Escape and return focus to the menu trigger. */
function handleDocumentKeydown(event: KeyboardEvent): void {
	if (event.key !== 'Escape') {
		return;
	}

	event.preventDefault();
	event.stopPropagation();
	close(true);
}

/** Dismiss this menu when another action menu opens. */
function handleOtherMenuOpen(event: Event): void {
	if (event instanceof CustomEvent && event.detail !== root.value) {
		close();
	}
}

/** Close after a link or button inside the menu is activated. */
function handleMenuClick(event: MouseEvent): void {
	if (event.target instanceof Element && event.target.closest('a, button, [role="menuitem"]')) {
		close(true);
	}
}

watch(open, (isOpen) => {
	if (isOpen) {
		document.addEventListener('pointerdown', handleDocumentPointer);
		document.addEventListener('keydown', handleDocumentKeydown);
		document.addEventListener(actionMenuOpenEvent, handleOtherMenuOpen);
	}
	else {
		document.removeEventListener('pointerdown', handleDocumentPointer);
		document.removeEventListener('keydown', handleDocumentKeydown);
		document.removeEventListener(actionMenuOpenEvent, handleOtherMenuOpen);
	}
});

onUnmounted(() => {
	document.removeEventListener('pointerdown', handleDocumentPointer);
	document.removeEventListener('keydown', handleDocumentKeydown);
	document.removeEventListener(actionMenuOpenEvent, handleOtherMenuOpen);
});
</script>

<template>
	<div ref="root" class="context-menu" :class="{ open }">
		<button
			ref="trigger"
			type="button"
			class="context-menu-trigger"
			:class="props.triggerClass"
			:aria-label="props.label"
			:aria-expanded="open"
			@click="toggle"
		>
			<slot name="trigger"></slot>
		</button>
		<Transition name="context-popover">
			<div
				v-if="open"
				class="context-menu-popover"
				:class="props.menuClass"
				@click.capture="handleMenuClick"
			>
				<slot></slot>
			</div>
		</Transition>
	</div>
</template>
