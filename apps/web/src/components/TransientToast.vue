<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';

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
const visible = ref(true);
let dismissTimer: number | undefined;

/** Stop the pending automatic dismissal while the toast is being used. */
function pauseDismissal(): void {
	window.clearTimeout(dismissTimer);
}

/** Schedule dismissal after a full readable interval. */
function scheduleDismissal(): void {
	pauseDismissal();
	dismissTimer = window.setTimeout(dismiss, props.duration);
}

/** Begin the toast's brief exit before releasing it from its parent. */
function dismiss(): void {
	pauseDismissal();
	visible.value = false;
}

/** Release the toast only when no newer message reversed the pending dismissal. */
function finishDismissal(): void {
	if (!visible.value) {
		emit('close');
	}
}

/** Present an updated notification for its full readable interval. */
function showUpdatedMessage(): void {
	visible.value = true;
	scheduleDismissal();
}

onMounted(scheduleDismissal);
onUnmounted(pauseDismissal);
watch(() => props.message, showUpdatedMessage);
</script>

<template>
	<Teleport to="body">
		<Transition name="transient-toast" appear @after-leave="finishDismissal">
			<div
				v-if="visible"
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
				<button type="button" aria-label="Dismiss notification" @click="dismiss">×</button>
			</div>
		</Transition>
	</Teleport>
</template>
