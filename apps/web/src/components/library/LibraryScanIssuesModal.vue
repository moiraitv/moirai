<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import TransientToast from '../TransientToast.vue';
import type { ScanIssue } from '@moirai/shared';
import { useAnimatedDismissal } from '../../motion';
import ResourceEditorHeader from '../ResourceEditorHeader.vue';

const props = defineProps<{ libraryId: string; issues: ScanIssue[]; suppressed?: boolean; sourceApprovalRequired: boolean }>();
const emit = defineEmits<{ close: []; refresh: [] }>();
const { visible, requestClose, finishClose } = useAnimatedDismissal(() => emit('close'));
const busy = ref(false);
const error = ref('');
const message = ref('');
const dialog = ref<HTMLElement>();

// Keep keyboard dismissal available when accepting or restoring removes the focused action.
watch(() => props.issues, () => {
	if (visible.value && dialog.value && !dialog.value.contains(document.activeElement)) {
		dialog.value.focus({ preventScroll: true });
	}
}, { flush: 'post' });

/** Persist a reversible decision, leaving failures visible in the dialog. */
async function acceptEnding(issue: ScanIssue): Promise<void> {
	if (!issue.path || !issue.tailAssessment || busy.value || props.sourceApprovalRequired) {
		return;
	}
	busy.value = true;
	error.value = '';
	const accepted = !issue.tailAssessment.accepted;
	try {
		await api.setSilentEndingAcceptance(props.libraryId, {
			path: issue.path, fingerprint: issue.tailAssessment.fingerprint, accepted,
		});
		message.value = accepted ? 'Silent ending accepted until the file changes.' : 'Warning restored.';
		emit('refresh');
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		busy.value = false;
	}
}
</script>

<template>
	<Teleport to="body">
		<Transition name="moirai-overlay" appear @after-leave="finishClose">
			<div v-show="visible" class="moirai-dialog-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="requestClose">
				<section ref="dialog" v-modal-focus="{ escape: requestClose }" class="moirai-dialog resource-editor-modal library-scan-issues-modal" role="dialog" aria-modal="true" aria-labelledby="scan-issues-title">
					<ResourceEditorHeader close-label="Close scan issues" @close="requestClose">
						<h2 id="scan-issues-title">{{ suppressed ? 'Suppressed issues' : 'Library scan issues' }} ({{ issues.length }})</h2>
					</ResourceEditorHeader>
					<div class="resource-editor-scroll">
						<p v-if="error" class="notice error" role="alert">{{ error }}</p>
						<p v-if="sourceApprovalRequired" id="silent-ending-source-approval" class="notice">Silent-ending decisions are unavailable for an unapproved source. Review and approve the source change, then complete a library sync before accepting or restoring warnings.</p>
						<p v-if="!suppressed">Accept a silent ending only after checking that no dialogue or music is missing. Acceptance lasts until the file changes.</p>
						<p v-if="!issues.length" class="empty-state">No issues remain in this list.</p>
						<ul class="library-warning-issues">
							<li v-for="(issue, index) in issues" :key="`${issue.path}:${index}`">
								<strong>{{ issue.code === 'media_audio_video_duration_mismatch' ? 'Audio/video duration mismatch' : issue.code }}</strong><span>{{ issue.path ?? issue.message }}</span><small v-if="issue.path">{{ issue.message }}</small>
								<small v-if="issue.tailAssessment?.result === 'black'">Automatically suppressed: the complete inspected tail is black.</small>
								<small v-else-if="issue.tailAssessment?.result === 'mostly-black'">Automatically suppressed: the complete inspected silent ending is at least 90% black in every frame.</small>
								<small v-else-if="issue.tailAssessment?.accepted">Suppressed: you accepted this file's silent ending.</small>
								<small v-else-if="issue.tailAssessment?.result === 'uncertain'">Tail inspection was inconclusive or exceeded its limits. This warning remains active.</small>
								<button v-if="issue.tailAssessment && !['black', 'mostly-black'].includes(issue.tailAssessment.result)" class="button secondary" type="button" :disabled="busy || sourceApprovalRequired" :aria-describedby="sourceApprovalRequired ? 'silent-ending-source-approval' : undefined" @click="acceptEnding(issue)">{{ issue.tailAssessment.accepted ? 'Restore warning' : 'Accept silent ending' }}</button>
							</li>
						</ul>
					</div>
				</section>
			</div>
		</Transition>
		<TransientToast v-if="message" :message="message" @close="message = ''" />
	</Teleport>
</template>
