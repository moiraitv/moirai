<script setup lang="ts">
import type { ScanRun } from '@moirai/shared';
import { useAnimatedDismissal } from '../../motion';
import ResourceEditorHeader from '../ResourceEditorHeader.vue';
import StatusPill from '../StatusPill.vue';

defineProps<{ scans: ScanRun[] }>();
const emit = defineEmits<{ close: [] }>();
const { visible, requestClose, finishClose } = useAnimatedDismissal(() => emit('close'));
</script>

<template>
	<Transition name="moirai-overlay" appear @after-leave="finishClose">
		<div v-show="visible" class="moirai-dialog-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="requestClose">
			<section v-modal-focus="{ escape: requestClose }" class="moirai-dialog resource-editor-modal library-scan-history-modal" role="dialog" aria-modal="true" aria-labelledby="scan-history-title">
				<ResourceEditorHeader close-label="Close scan history" @close="requestClose">
					<h2 id="scan-history-title">Scan history</h2>
				</ResourceEditorHeader>
				<div class="resource-editor-scroll">
					<div v-if="scans.length" class="diagnostics">
						<article v-for="run in scans" :key="run.id">
							<StatusPill :value="run.status" />
							<span>{{ new Date(run.startedAt).toLocaleString() }}</span>
							<span>{{ run.discoveredCount }} found · {{ run.changedCount }} changed · {{ run.removedCount }} removed</span>
							<ul v-if="run.issues.length">
								<li v-for="issue in run.issues" :key="`${issue.code}:${issue.path}`">{{ issue.code }} — {{ issue.path ?? issue.message }}</li>
							</ul>
						</article>
					</div>
					<p v-else class="empty-state">No scans have been recorded for this library.</p>
				</div>
			</section>
		</div>
	</Transition>
</template>
