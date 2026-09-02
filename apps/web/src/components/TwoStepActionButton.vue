<script setup lang="ts">
import { CircleAlert } from '@lucide/vue';
import { onBeforeUnmount, ref } from 'vue';
import { claimInlineAction, releaseInlineAction } from '../inline-action-coordination';

/** Props for a compact action that requires a deliberate second activation. */
interface TwoStepActionButtonProps {
	label: string;
	confirmLabel: string;
	confirmText?: string;
	disabled?: boolean;
	timeoutMilliseconds?: number;
	tone?: 'danger' | 'caution';
}

const props = withDefaults(defineProps<TwoStepActionButtonProps>(), {
	confirmText: '',
	disabled: false,
	timeoutMilliseconds: 5_000,
	tone: 'danger',
});
const emit = defineEmits<{ confirm: [] }>();

const button = ref<HTMLButtonElement | null>(null);
const armed = ref(false);
let disarmTimer: ReturnType<typeof setTimeout> | undefined;

/** Return the control to its initial state. */
function disarm(): void {
	armed.value = false;
	releaseInlineAction(disarm);
	document.removeEventListener('pointerdown', handleDocumentPointer);
	if (disarmTimer !== undefined) {
		clearTimeout(disarmTimer);
		disarmTimer = undefined;
	}
}

/** Arm the action, or confirm it on a deliberate second activation. */
function activate(): void {
	if (props.disabled) {
		return;
	}

	if (armed.value) {
		disarm();
		emit('confirm');
		return;
	}

	claimInlineAction(disarm);
	armed.value = true;
	document.addEventListener('pointerdown', handleDocumentPointer);
	disarmTimer = setTimeout(disarm, props.timeoutMilliseconds);
}

/** Disarm when a pointer action begins outside the armed control. */
function handleDocumentPointer(event: PointerEvent): void {
	if (armed.value && event.target instanceof Node && !button.value?.contains(event.target)) {
		disarm();
	}
}

/** Let Escape safely cancel the pending action. */
function handleKeydown(event: KeyboardEvent): void {
	if (armed.value && event.key === 'Escape') {
		event.stopPropagation();
		disarm();
		button.value?.focus();
	}
}

onBeforeUnmount(() => {
	disarm();
});
</script>

<template>
	<button
		ref="button"
		type="button"
		class="two-step-action-button"
		:class="[`tone-${tone}`, { 'is-armed': armed }]"
		:disabled="disabled"
		:aria-label="armed ? confirmLabel : label"
		:aria-pressed="armed"
		:title="armed ? confirmLabel : label"
		@click="activate"
		@blur="disarm"
		@keydown="handleKeydown"
	>
		<template v-if="armed">
			<CircleAlert :size="17" aria-hidden="true" />
			<span v-if="confirmText">{{ confirmText }}</span>
		</template>
		<slot v-else />
	</button>
</template>
