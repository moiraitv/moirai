<script setup lang="ts">
import { computed, useId } from 'vue';
import { backupFilename, type BackupReview } from '@moirai/shared';
import { backupCategory, backupCreatedDate, backupSize } from '../backup-format';
import ResourceEditorHeader from './ResourceEditorHeader.vue';
import LoadingState from './LoadingState.vue';

const props = defineProps<{
	review: BackupReview | null;
	sourceName: string;
	validating: boolean;
	validationProgress: string;
	restoring: boolean;
	restarting: boolean;
	busy: boolean;
	error: string;
}>();
const emit = defineEmits<{ close: []; restore: [] }>();
const titleId = useId();
const committed = computed(() => props.restoring || props.restarting);
const title = computed(() => committed.value ? 'Restoring Configuration' : props.validating ? 'Validating Backup' : props.review ? 'Replace Configuration?' : 'Backup Validation Failed');

/** Keep dismissal disabled after the final replacement request has started. */
function close(): void {
	if (!committed.value) {
		emit('close');
	}
}
</script>

<template>
	<Teleport to="body">
		<div class="moirai-dialog-backdrop" @click.self="close">
			<section v-modal-focus="{ escape: close }" class="moirai-dialog resource-editor-modal backup-restore-modal" :role="review && !committed ? 'alertdialog' : 'dialog'" aria-modal="true" :aria-labelledby="titleId">
				<ResourceEditorHeader close-label="Close restore review" :disabled="committed" @close="close">
					<p class="eyebrow">Backup &amp; Restore</p>
					<h2 :id="titleId">{{ title }}</h2>
				</ResourceEditorHeader>
				<div class="resource-editor-scroll backup-restore-body">
					<p v-if="!review" class="backup-restore-name">{{ sourceName }}</p>
					<p v-if="error" class="notice error" role="alert">{{ error }}</p>
					<LoadingState v-if="validating" :label="validationProgress || 'Validating backup…'" />
					<LoadingState v-if="committed" :label="restarting ? 'Restoring configuration and restarting Moirai…' : 'Preparing recovery backup and restore…'" />
					<template v-if="review">
						<dl class="backup-restore-summary">
							<dt>Backup</dt><dd>{{ backupFilename(review.backup) }}</dd>
							<dt>Created</dt><dd>{{ backupCreatedDate(review.backup.createdAt) }}</dd>
							<dt>Type</dt><dd>{{ backupCategory(review.backup.kind) }}</dd>
							<dt>Application version</dt><dd>Moirai {{ review.backup.applicationVersion }}</dd>
							<dt>Size</dt><dd>{{ backupSize(review.backup.size) }}</dd>
						</dl>
						<p>{{ review.libraries }} libraries · {{ review.mediaItems }} media items · {{ review.channels }} channels</p>
						<p>Restoring replaces the current configuration and stops playback while Moirai restarts. Administrator access is preserved; you must sign in again and re-enter AI credentials.</p>
					</template>
				</div>
				<footer class="resource-editor-action-bar">
					<div class="form-actions">
						<button type="button" class="button secondary" :disabled="committed" @click="close">{{ review ? 'Cancel Restore' : validating ? 'Cancel' : 'Close' }}</button>
						<button v-if="review" type="button" class="button danger" :disabled="busy || committed" @click="emit('restore')">Restore and Restart</button>
					</div>
				</footer>
			</section>
		</div>
	</Teleport>
</template>
