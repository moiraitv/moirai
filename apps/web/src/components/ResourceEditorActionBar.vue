<script setup lang="ts">
import { RotateCcw, Save, Trash2 } from '@lucide/vue';
import { computed } from 'vue';
import TwoStepActionButton from './TwoStepActionButton.vue';

const props = withDefaults(defineProps<{
	resourceType?: string;
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
	reset: [];
	save: [];
}>();

const deleteLabel = computed(() => `Delete ${props.resourceType}`);

/** Emit a save request when no containing form owns submission. */
function activateSave(): void {
	if (!props.saveSubmits) {
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
		<p v-if="validationMessage" class="field-error resource-editor-validation" role="status">{{ validationMessage }}</p>
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
				:type="saveSubmits ? 'submit' : 'button'"
				class="button"
				:disabled="busy || saveDisabled"
				:aria-label="saving ? savingLabel : saveLabel"
				:title="saving ? savingLabel : saveLabel"
				@click="activateSave"
			>
				<Save class="resource-editor-action-icon" :size="18" aria-hidden="true" /><span>{{ saving ? savingLabel : saveLabel }}</span>
			</button>
		</div>
	</footer>
</template>
