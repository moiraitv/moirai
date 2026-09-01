<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, useTemplateRef, watch } from 'vue';

const props = withDefaults(defineProps<{
	title: string;
	message: string;
	confirmLabel?: string;
	destructive?: boolean;
}>(), {
	confirmLabel: 'Confirm',
	destructive: false,
});
const emit = defineEmits<{
	cancel: [];
	confirm: [];
}>();
const dialog = useTemplateRef<HTMLElement>('dialog');
const cancelButton = useTemplateRef<HTMLButtonElement>('cancelButton');
const previouslyFocused = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
	? document.activeElement
	: null;

/** Put keyboard focus on the least destructive action after the dialog renders or changes. */
async function focusSafestAction(): Promise<void> {
	await nextTick();
	cancelButton.value?.focus();
}

/** Keep Tab navigation and Escape handling within the active modal confirmation. */
function handleKeydown(event: KeyboardEvent): void {
	if (event.key === 'Escape') {
		event.stopPropagation();
		event.preventDefault();
		emit('cancel');
		return;
	}
	if (event.key !== 'Tab') {
		return;
	}

	const focusable = [...(dialog.value?.querySelectorAll<HTMLElement>(
		'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), '
		+ 'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
	) ?? [])].filter((element) => element.getClientRects().length > 0);
	if (focusable.length === 0) {
		event.preventDefault();
		return;
	}

	const first = focusable[0]!;
	const last = focusable.at(-1)!;
	const activeElement = document.activeElement;
	if (event.shiftKey && (activeElement === first || !dialog.value?.contains(activeElement))) {
		event.preventDefault();
		last.focus();
	}
	else if (!event.shiftKey && (activeElement === last || !dialog.value?.contains(activeElement))) {
		event.preventDefault();
		first.focus();
	}
}

onMounted(() => void focusSafestAction());
watch(
	() => [props.title, props.message, props.confirmLabel],
	() => void focusSafestAction(),
);
onUnmounted(() => {
	if (previouslyFocused?.isConnected) {
		previouslyFocused.focus();
	}
});
</script>

<template>
	<Teleport to="body">
		<div class="moirai-dialog-backdrop confirmation-modal-backdrop" @click.self="emit('cancel')">
			<section
				ref="dialog"
				class="moirai-dialog confirmation-modal"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="confirmation-modal-title"
				aria-describedby="confirmation-modal-message"
				@keydown="handleKeydown"
			>
				<header>
					<p class="eyebrow">Confirmation required</p>
					<h2 id="confirmation-modal-title">{{ title }}</h2>
				</header>
				<p id="confirmation-modal-message">{{ message }}</p>
				<footer>
					<button ref="cancelButton" type="button" class="button secondary" @click="emit('cancel')">
						Cancel
					</button>
					<button
						type="button"
						class="button"
						:class="{ danger: props.destructive }"
						@click="emit('confirm')"
					>
						{{ confirmLabel }}
					</button>
				</footer>
			</section>
		</div>
	</Teleport>
</template>
