<script setup lang="ts">
import { useDisclosureState } from '../../disclosure-state';
import { RefreshCw } from '@lucide/vue';
import type { TimelinePreview } from '@moirai/shared';
import ResolvedGuideTrack from './ResolvedGuideTrack.vue';
import AnimatedDisclosure from '../AnimatedDisclosure.vue';

defineProps<{
	preview: TimelinePreview | null;
	stale: boolean;
	updating: boolean;
	queued: boolean;
	error: string;
}>();
const emit = defineEmits<{ refresh: [] }>();
const issuesOpen = useDisclosureState('resolved-schedule-issues', false);
</script>

<template>
	<section class="resolved-preview scheduling-preview-dock editor-surface">
		<div class="template-panel-heading preview-heading">
			<div>
				<p class="eyebrow">Materialized output</p>
				<h2>Preview resolved schedule</h2>
			</div>
			<div class="preview-controls">
				<button type="button" class="toolbar-button" :disabled="updating" @click="emit('refresh')">
					<RefreshCw :size="16" :class="{ spinning: updating }" />
					{{ updating ? 'Updating…' : queued ? 'Update Now' : 'Refresh Now' }}
				</button>
			</div>
		</div>
		<p v-if="error" class="notice error">{{ error }}</p>
		<div class="resolved-track-shell resolved-preview-track-shell">
			<ResolvedGuideTrack :preview="preview" />
			<div
				v-if="!error && (stale || (!preview && (queued || updating)))"
				class="resolved-preview-loading"
				role="status"
				aria-live="polite"
			>
				<RefreshCw :size="17" class="spinning" aria-hidden="true" />
				<span>{{ updating ? 'Updating resolved schedule…' : 'Schedule changed — refreshing preview...' }}</span>
			</div>
		</div>
		<AnimatedDisclosure v-if="preview?.issues.length" v-model="issuesOpen" class="timeline-issues compact-preview-issues">
			<template #summary><span>
				{{ preview.issues.length }} preview issue{{ preview.issues.length === 1 ? '' : 's' }}
			</span></template>
			<article
				v-for="issue in preview.issues"
				:key="`${issue.slotId}-${issue.code}-${issue.programId}`"
			>
				<strong>{{ issue.code }}</strong><span>{{ issue.message }}</span>
			</article>
		</AnimatedDisclosure>
	</section>
</template>
