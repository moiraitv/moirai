<script setup lang="ts">
import { Save } from '@lucide/vue';
import TwoStepActionButton from './TwoStepActionButton.vue';

withDefaults(defineProps<{
	label: string;
	dirty: boolean;
	valid: boolean;
	busy: boolean;
	ready: boolean;
	saving?: boolean;
	savingLabel?: string;
}>(), { saving: false, savingLabel: 'Saving…' });
const emit = defineEmits<{ reset: [] }>();
</script>

<template>
	<footer class="settings-save-footer" :aria-label="`${label} settings actions`">
		<span class="settings-save-state">{{ ready ? dirty ? 'Unsaved changes' : 'No unsaved changes' : '' }}</span>
		<div class="form-actions">
			<TwoStepActionButton
				class="button secondary"
				:label="`Reset ${label} settings draft`"
				:confirm-label="`Confirm Reset ${label} settings draft`"
				tone="caution"
				:disabled="busy || !ready || !dirty"
				@confirm="emit('reset')"
			>Reset</TwoStepActionButton>
			<button type="submit" class="button" :aria-label="`Save ${label} Settings`" :disabled="busy || !ready || !dirty || !valid"><Save :size="17" />{{ saving ? savingLabel : 'Save' }}</button>
		</div>
	</footer>
</template>
