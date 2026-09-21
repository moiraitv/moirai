<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import TransientToast from '../TransientToast.vue';
import { mediaIssueIgnoreState, isIgnorableMediaIssue, isAutomaticallySuppressedScanIssue, type ScanIssue } from '@moirai/shared';
import { useAnimatedDismissal } from '../../motion';
import ResourceEditorHeader from '../ResourceEditorHeader.vue';

const props = defineProps<{ libraryId: string; issues: ScanIssue[]; suppressed?: boolean; suppressedCount?: number; sourceApprovalRequired: boolean }>();
const emit = defineEmits<{ close: []; refresh: []; showSuppressed: [] }>();
const { visible, requestClose, finishClose } = useAnimatedDismissal(() => emit('close'));
const busy = ref(false);
const error = ref('');
const message = ref('');
const dialog = ref<HTMLElement>();
const titleId = useId();
const sourceApprovalId = useId();

// Keep keyboard dismissal available when accepting or restoring removes the focused action.
watch(() => props.issues, () => {
	if (visible.value && dialog.value && !dialog.value.contains(document.activeElement)) {
		dialog.value.focus({ preventScroll: true });
	}
}, { flush: 'post' });

/** Persist a reversible decision, leaving failures visible in the dialog. */
async function ignoreIssue(issue: ScanIssue): Promise<void> {
	const state = mediaIssueIgnoreState(issue);
	if (!issue.path || !state || !isIgnorableMediaIssue(issue) || busy.value || props.sourceApprovalRequired) {
		return;
	}
	busy.value = true;
	error.value = '';
	const ignored = !state.ignored;
	try {
		await api.setMediaIssueIgnored(props.libraryId, {
			path: issue.path, code: issue.code, fingerprint: state.fingerprint, ignored,
		});
		message.value = ignored ? 'Issue ignored until its relevant files change.' : 'Issue restored.';
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
				<section ref="dialog" v-modal-focus="{ escape: requestClose }" class="moirai-dialog resource-editor-modal library-scan-issues-modal" role="dialog" aria-modal="true" :aria-labelledby="titleId">
					<ResourceEditorHeader close-label="Close scan issues" @close="requestClose">
						<h2 :id="titleId">{{ suppressed ? 'Suppressed issues' : 'Library scan issues' }} ({{ issues.length }})</h2>
					</ResourceEditorHeader>
					<div class="resource-editor-scroll">
						<button v-if="!suppressed && suppressedCount" type="button" class="button secondary library-suppressed-issues" @click="emit('showSuppressed')">Suppressed issues ({{ suppressedCount }})</button>
						<p v-if="error" class="notice error" role="alert">{{ error }}</p>
						<p v-if="sourceApprovalRequired" :id="sourceApprovalId" class="notice">Ignore and restore are unavailable for an unapproved source. Review and approve the source change, then complete a library sync.</p>
						<p v-if="!suppressed">Ignore an issue to hide it from attention counts until its relevant files change. Ignoring does not repair files, make media playable, resolve catalog conflicts, or approve source changes or removals.</p>
						<p v-if="!issues.length" class="empty-state">No issues remain in this list.</p>
						<ul class="library-warning-issues">
							<li v-for="(issue, index) in issues" :key="`${issue.path}:${index}`">
								<strong>{{ issue.code === 'media_audio_video_duration_mismatch' ? 'Audio/video duration mismatch' : issue.code }}</strong><span>{{ issue.path ?? issue.message }}</span><small v-if="issue.path">{{ issue.message }}</small>
								<small v-if="issue.ignoreState?.ignored || issue.tailAssessment?.accepted">Suppressed: you ignored this issue until its relevant files change.</small>
								<small v-else-if="issue.tailAssessment?.result === 'black'">Automatically suppressed: the complete inspected tail is black.</small>
								<small v-else-if="issue.tailAssessment?.result === 'mostly-black'">Automatically suppressed: the complete inspected silent ending is at least 90% black in every frame.</small>
								<small v-else-if="issue.tailAssessment?.result === 'within-duration-tolerance'">Automatically suppressed: every measured audio track is no more than 5% shorter than the video and no more than 30 seconds longer.</small>
								<small v-else-if="issue.tailAssessment?.result === 'uncertain'">Tail inspection was inconclusive or exceeded its limits. This warning remains active.</small>
								<button v-if="mediaIssueIgnoreState(issue) && (mediaIssueIgnoreState(issue)?.ignored || !isAutomaticallySuppressedScanIssue(issue))" class="button secondary" type="button" :disabled="busy || sourceApprovalRequired" :aria-describedby="sourceApprovalRequired ? sourceApprovalId : undefined" @click="ignoreIssue(issue)">{{ mediaIssueIgnoreState(issue)?.ignored ? 'Restore issue' : 'Ignore issue' }}</button>
							</li>
						</ul>
					</div>
				</section>
			</div>
		</Transition>
		<TransientToast v-if="message" :message="message" @close="message = ''" />
	</Teleport>
</template>
