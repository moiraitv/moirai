<script setup lang="ts">
import { computed, ref } from 'vue';
import { RefreshCw } from '@lucide/vue';
import type { TimelinePreview } from '@moirai/shared';
import { guideSegmentPercent, guideWindowMilliseconds } from '../../guide-geometry';
import { programColorStyle } from '../../program-colors';
import { instantLabel } from '../../time-format';
import AnimatedDisclosure from '../AnimatedDisclosure.vue';

const props = defineProps<{
	preview: TimelinePreview | null;
	stale: boolean;
	updating: boolean;
	queued: boolean;
	error: string;
}>();
const emit = defineEmits<{ refresh: [] }>();
const issuesOpen = ref(false);
const previewWindowMilliseconds = computed(() => props.preview
	? guideWindowMilliseconds(props.preview.startDate, props.preview.days, props.preview.timeZone)
	: 0);

/** Return the user-facing label for time. */
function timeLabel(value: string): string {
	try {
		return instantLabel(value, {
			hour: 'numeric',
			minute: '2-digit',
		}, props.preview?.timeZone);
	}
	catch {
		return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}
}

/** Format a segment start and finish as one readable time range. */
function timeRange(start: string, finish: string): string {
	return `${timeLabel(start)}–${timeLabel(finish)}`;
}
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
			<div class="resolved-track" :class="{ 'is-placeholder': !preview }">
				<template v-if="preview">
					<div
						v-for="segment in preview.segments"
						:key="segment.id"
						class="resolved-segment"
						:class="[`role-${segment.role}`, { truncated: segment.truncated }]"
						:style="{
							...programColorStyle(segment.programId),
							width: `${guideSegmentPercent(
								segment.start,
								segment.finish,
								previewWindowMilliseconds,
							)}%`,
						}"
						:title="`${segment.title} · ${timeRange(segment.start, segment.finish)}`"
						:aria-label="`${segment.title}, ${timeRange(segment.start, segment.finish)}`"
					>
						<strong>{{ segment.title }}</strong>
						<small>{{ timeRange(segment.start, segment.finish) }}</small>
					</div>
				</template>
			</div>
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
