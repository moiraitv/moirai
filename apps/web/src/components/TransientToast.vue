<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue';

const props = withDefaults(defineProps<{
	message?: string;
	tone?: 'neutral' | 'success';
	duration?: number;
}>(), {
	message: '',
	tone: 'success',
	duration: 5000,
});
const emit = defineEmits<{ close: [] }>();
let dismissTimer: number | undefined;

/** Stop the pending automatic dismissal while the toast is being used. */
function pauseDismissal(): void {
	window.clearTimeout(dismissTimer);
}

/** Schedule dismissal after a full readable interval. */
function scheduleDismissal(): void {
	pauseDismissal();
	dismissTimer = window.setTimeout(() => emit('close'), props.duration);
}

onMounted(scheduleDismissal);
onUnmounted(pauseDismissal);
watch(() => props.message, scheduleDismissal);
</script>

<template>
	<Teleport to="body">
		<div
			class="transient-toast"
			:class="`transient-toast-${tone}`"
			role="status"
			@mouseenter="pauseDismissal"
			@mouseleave="scheduleDismissal"
			@focusin="pauseDismissal"
			@focusout="scheduleDismissal"
		>
			<span v-if="message">{{ message }}</span>
			<slot v-else></slot>
			<button type="button" aria-label="Dismiss notification" @click="emit('close')">×</button>
		</div>
	</Teleport>
</template>
