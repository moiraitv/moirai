<script setup lang="ts">
import { RotateCcw, Save, Trash2, X } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import TransientToast from './TransientToast.vue';
import TwoStepActionButton from './TwoStepActionButton.vue';

const props = withDefaults(defineProps<{
	resourceType?: string;
	pending?: boolean;
	draftWarning?: string;
	draftRestored?: boolean;
	saveLabel?: string;
	savingLabel?: string;
	validationMessage?: string;
	showDelete?: boolean;
	busy?: boolean;
	deleting?: boolean;
	resetDisabled?: boolean;
	saveDisabled?: boolean;
	saveSubmits?: boolean;
	saving?: boolean;
}>(), {
	resourceType: '',
	pending: true,
	draftWarning: '',
	draftRestored: false,
	saveLabel: 'Save',
	savingLabel: 'Saving…',
	validationMessage: '',
	showDelete: false,
	busy: false,
	deleting: false,
	resetDisabled: false,
	saveDisabled: false,
	saveSubmits: false,
	saving: false,
});

const emit = defineEmits<{
	delete: [];
	close: [];
	reset: [];
	save: [];
}>();

const noticeMessage = ref('');
watch(() => props.draftRestored, restored => {
	if (restored) {
		noticeMessage.value = 'Previous draft restored';
	}
	else if (noticeMessage.value === 'Previous draft restored') {
		noticeMessage.value = '';
	}
}, { immediate: true });
watch(() => props.saving, (saving, previous) => {
	if (previous && !saving && !props.pending) {
		noticeMessage.value = `${props.resourceType || 'Changes'} saved.`;
	}
});
const deleteLabel = computed(() => `Delete ${props.resourceType}`);

/** Emit a save request when no containing form owns submission. */
function activateSave(): void {
	if (!props.pending) {
		emit('close');
	}
	else if (!props.saveSubmits) {
		emit('save');
	}
}
</script>

<template>
	<footer class="resource-editor-action-bar">
		<div class="resource-editor-danger-actions">
			<button
				v-if="showDelete"
				type="button"
				class="button resource-editor-delete"
				:disabled="busy"
				:aria-label="deleting ? 'Deleting…' : deleteLabel"
				:title="deleting ? 'Deleting…' : deleteLabel"
				@click="emit('delete')"
			>
				<Trash2 class="resource-editor-action-icon" :size="18" aria-hidden="true" /><span>{{ deleting ? 'Deleting…' : deleteLabel }}</span>
			</button>
		</div>
		<p v-if="draftWarning" class="field-error resource-editor-validation" role="alert">{{ draftWarning }}</p>
		<p v-else-if="validationMessage" class="field-error resource-editor-validation" role="status">{{ validationMessage }}</p>
		<div class="resource-editor-save-actions">
			<TwoStepActionButton
				class="button secondary"
				tone="caution"
				label="Reset"
				confirm-label="Confirm Reset"
				confirm-text="Confirm Reset"
				:disabled="busy || resetDisabled"
				@confirm="emit('reset')"
			>
				<RotateCcw class="resource-editor-action-icon" :size="18" aria-hidden="true" /><span>Reset</span>
			</TwoStepActionButton>
			<button
				:type="pending && saveSubmits ? 'submit' : 'button'"
				class="button"
				:class="{ secondary: !pending }"
				:disabled="busy || (pending && saveDisabled)"
				:aria-label="saving ? savingLabel : pending ? saveLabel : 'Close'"
				:title="saving ? savingLabel : pending ? saveLabel : 'Close'"
				@click="activateSave"
			>
				<component :is="pending ? Save : X" class="resource-editor-action-icon" :size="18" aria-hidden="true" /><span>{{ saving ? savingLabel : pending ? saveLabel : 'Close' }}</span>
			</button>
		</div>
		<div v-if="noticeMessage" class="resource-editor-save-notice"><TransientToast inline :message="noticeMessage" :tone="noticeMessage === 'Previous draft restored' ? 'neutral' : 'success'" @close="noticeMessage = ''" /></div>
	</footer>
</template>
