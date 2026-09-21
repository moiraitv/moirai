<script setup lang="ts">
import { computed, ref } from 'vue';
import { isSuppressedScanIssue, type ScanRun } from '@moirai/shared';
import { scanIssuesRequireSourceApproval } from '../../library-scan-issues';
import LibraryScanIssuesModal from './LibraryScanIssuesModal.vue';
import { useAnimatedDismissal } from '../../motion';
import ResourceEditorHeader from '../ResourceEditorHeader.vue';
import StatusPill from '../StatusPill.vue';

const props = defineProps<{ libraryId: string; scans: ScanRun[] }>();
const emit = defineEmits<{ close: []; refresh: [] }>();
const { visible, requestClose, finishClose } = useAnimatedDismissal(() => emit('close'));
const suppressedOpen = ref(false);
const currentIssues = computed(() => props.scans.find(scan => scan.status !== 'running')?.issues ?? []);
const suppressedIssues = computed(() => currentIssues.value.filter(isSuppressedScanIssue));
const sourceApprovalRequired = computed(() => scanIssuesRequireSourceApproval(currentIssues.value));
</script>

<template>
	<Transition name="moirai-overlay" appear @after-leave="finishClose">
		<div v-show="visible" class="moirai-dialog-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="requestClose">
			<section v-modal-focus="{ escape: requestClose }" class="moirai-dialog resource-editor-modal library-scan-history-modal" role="dialog" aria-modal="true" aria-labelledby="scan-history-title">
				<ResourceEditorHeader close-label="Close scan history" @close="requestClose">
					<h2 id="scan-history-title">Scan history</h2>
				</ResourceEditorHeader>
				<div class="resource-editor-scroll">
					<button v-if="suppressedIssues.length" type="button" class="button secondary library-suppressed-issues" @click="suppressedOpen = true">Suppressed issues ({{ suppressedIssues.length }})</button>
					<div v-if="scans.length" class="diagnostics">
						<article v-for="run in scans" :key="run.id">
							<StatusPill :value="run.status" />
							<span>{{ new Date(run.startedAt).toLocaleString() }}</span>
							<span>{{ run.discoveredCount }} found · {{ run.changedCount }} changed · {{ run.removedCount }} removed</span>
							<ul v-if="run.issues.length">
								<li v-for="issue in run.issues" :key="`${issue.code}:${issue.path}`">
									<span>{{ issue.code }}<template v-if="issue.path"> — {{ issue.path }}</template></span>
									<div>{{ issue.message }}</div>
									<small v-if="issue.ignoreState?.ignored || issue.tailAssessment?.accepted">Suppressed: manually ignored until relevant files change.</small>
									<small v-else-if="issue.tailAssessment?.result === 'black'">Suppressed: confirmed black tail</small>
									<small v-else-if="issue.tailAssessment?.result === 'mostly-black'">Suppressed: the complete inspected silent ending is at least 90% black in every frame.</small>
									<small v-else-if="issue.tailAssessment?.result === 'within-duration-tolerance'">Suppressed: audio durations are within 5% shorter and 30 seconds longer than the video.</small>
								</li>
							</ul>
						</article>
					</div>
					<p v-else class="empty-state">No scans have been recorded for this library.</p>
				</div>
			</section>
		</div>
	</Transition>
	<LibraryScanIssuesModal v-if="suppressedOpen" :library-id="libraryId" :issues="suppressedIssues" suppressed :source-approval-required="sourceApprovalRequired" @close="suppressedOpen = false" @refresh="emit('refresh')" />
</template>
