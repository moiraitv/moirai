<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue';

const props = withDefaults(defineProps<{
	title: string;
	message: string;
	confirmLabel?: string;
	destructive?: boolean;
	alternateLabel?: string | null;
	alternateDestructive?: boolean;
}>(), {
	confirmLabel: 'Confirm',
	destructive: false,
	alternateLabel: null,
	alternateDestructive: false,
});
const emit = defineEmits<{
	cancel: [];
	confirm: [];
	alternate: [];
}>();
const dialog = useTemplateRef<HTMLElement>('dialog');
const cancelButton = useTemplateRef<HTMLButtonElement>('cancelButton');
const visible = ref(true);
const result = ref<'confirm' | 'alternate' | 'cancel' | null>(null);
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
		requestClose('cancel');
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

/** Begin dismissal and remember which confirmation result to emit after the exit transition. */
function requestClose(resolution: 'confirm' | 'alternate' | 'cancel'): void {
	if (!visible.value) {
		return;
	}

	result.value = resolution;
	visible.value = false;
}

/** Settle the confirmation only after its dialog has visually left the page. */
function finishClose(): void {
	if (result.value === 'confirm') {
		emit('confirm');
	}
	else if (result.value === 'alternate') {
		emit('alternate');
	}
	else {
		emit('cancel');
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
		<Transition name="moirai-overlay" appear @after-leave="finishClose">
			<div v-show="visible" class="moirai-dialog-backdrop confirmation-modal-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="requestClose('cancel')">
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
						<button ref="cancelButton" type="button" class="button secondary" @click="requestClose('cancel')">
							Cancel
						</button>
						<button
							v-if="alternateLabel"
							type="button"
							class="button secondary"
							:class="{ danger: props.alternateDestructive }"
							@click="requestClose('alternate')"
						>
							{{ alternateLabel }}
						</button>
						<button
							type="button"
							class="button"
							:class="{ danger: props.destructive }"
							@click="requestClose('confirm')"
						>
							{{ confirmLabel }}
						</button>
					</footer>
				</section>
			</div>
		</Transition>
	</Teleport>
</template>
