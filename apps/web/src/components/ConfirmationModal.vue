<script setup lang="ts">
import { nextTick, onMounted, ref, useTemplateRef, watch } from 'vue';

const props = withDefaults(defineProps<{
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	destructive?: boolean;
	requiredText?: string | null;
	requiredTextLabel?: string | null;
	alternateLabel?: string | null;
	alternateDestructive?: boolean;
}>(), {
	confirmLabel: 'Confirm',
	cancelLabel: 'Cancel',
	destructive: false,
	requiredText: null,
	requiredTextLabel: null,
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
const confirmationText = ref('');
const result = ref<'confirm' | 'alternate' | 'cancel' | null>(null);


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
	() => {
		confirmationText.value = '';
		void focusSafestAction();
	},
);

</script>

<template>
	<Teleport to="body">
		<Transition name="moirai-overlay" appear @after-leave="finishClose">
			<div v-show="visible" class="moirai-dialog-backdrop confirmation-modal-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="requestClose('cancel')">
				<section
					ref="dialog"
					v-modal-focus="{ escape: () => requestClose('cancel') }"
					class="moirai-dialog confirmation-modal" role="alertdialog"
					aria-modal="true"
					aria-labelledby="confirmation-modal-title"
					aria-describedby="confirmation-modal-message"
					@keydown="handleKeydown"
				>
					<header>
						<p class="eyebrow">Confirmation required</p>
						<h2 id="confirmation-modal-title">{{ title }}</h2>
					</header>
					<div class="confirmation-modal-body">
						<p id="confirmation-modal-message">{{ message }}</p>
						<label v-if="requiredText" class="confirmation-required-text">
							<span>{{ requiredTextLabel ?? `Type ${requiredText} to confirm` }}</span>
							<input v-model="confirmationText" autocomplete="off" />
						</label>
					</div>
					<footer>
						<button ref="cancelButton" type="button" class="button secondary" @click="requestClose('cancel')">
							{{ cancelLabel }}
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
							:disabled="requiredText !== null && confirmationText !== requiredText"
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
