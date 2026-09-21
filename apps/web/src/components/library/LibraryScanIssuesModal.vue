<script setup lang="ts">
import type { ScanIssue } from '@moirai/shared';
import { useAnimatedDismissal } from '../../motion';
import ResourceEditorHeader from '../ResourceEditorHeader.vue';

defineProps<{ issues: ScanIssue[] }>();
const emit = defineEmits<{ close: [] }>();
const { visible, requestClose, finishClose } = useAnimatedDismissal(() => emit('close'));
</script>

<template>
	<Teleport to="body">
		<Transition name="moirai-overlay" appear @after-leave="finishClose">
			<div v-show="visible" class="moirai-dialog-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="requestClose">
				<section v-modal-focus="{ escape: requestClose }" class="moirai-dialog resource-editor-modal library-scan-issues-modal" role="dialog" aria-modal="true" aria-labelledby="scan-issues-title">
					<ResourceEditorHeader close-label="Close scan issues" @close="requestClose">
						<h2 id="scan-issues-title">Library scan issues ({{ issues.length }})</h2>
					</ResourceEditorHeader>
					<div class="resource-editor-scroll">
						<ul class="library-warning-issues">
							<li v-for="(issue, index) in issues" :key="index"><strong>{{ issue.code }}</strong><span>{{ issue.path ?? issue.message }}</span><small v-if="issue.path">{{ issue.message }}</small></li>
						</ul>
					</div>
				</section>
			</div>
		</Transition>
	</Teleport>
</template>
