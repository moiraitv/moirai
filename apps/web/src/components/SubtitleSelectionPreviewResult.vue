<script setup lang="ts">
import type { SubtitleSelectionPreviewResult, SubtitleRejectionReason } from '@moirai/shared';

defineProps<{ result: SubtitleSelectionPreviewResult }>();
/** Plain-language explanations of the constraints enforced by playback. */
const reasons: Record<SubtitleRejectionReason, string> = {
	off: 'Ordinary subtitles are off', part: 'Different physical part', language: 'Language does not match',
	title: 'Title is missing or does not match', forced: 'File’s forced flag is missing',
};
</script>

<template>
	<div class="subtitle-preview-result" aria-live="polite">
		<p v-for="limitation in result.limitations" :key="limitation" class="notice">{{ limitation }}</p>
		<section v-for="part in result.parts" :key="part.number" :aria-label="result.parts.length > 1 ? `Subtitle selection for part ${part.number}` : 'Subtitle selection'">
			<h4 v-if="result.parts.length > 1">Part {{ part.number }}</h4>
			<p v-if="part.outcome === 'credits'">Music video credits replace ordinary subtitles on this video.</p>
			<p v-else-if="part.outcome === 'off'">Ordinary subtitles are off.</p>
			<p v-else-if="part.outcome === 'no-match'">No eligible track matches. This part will play without ordinary subtitles.</p>
			<p v-if="!part.tracks.length">No subtitle tracks are recorded for this part.</p>
			<ul v-else class="subtitle-preview-tracks">
				<li v-for="entry in part.tracks" :key="entry.track.id" :class="{ selected: entry.track.id === part.selectedTrackId }">
					<div class="subtitle-preview-track-header">
						<strong class="subtitle-track-title"><span>{{ entry.track.title || 'Untitled track' }}</span> <span class="subtitle-language-badge">{{ entry.track.language?.toUpperCase() || 'Unknown language' }}</span></strong>
						<span class="subtitle-preview-track-metadata">{{ entry.track.sourceType === 'embedded' ? 'Embedded' : 'Sidecar' }} · {{ entry.track.codec || entry.track.format || 'Unknown format' }}{{ result.parts.length > 1 ? ` · ${entry.track.partNumber === null ? 'All parts' : `Part ${entry.track.partNumber}`}` : '' }}{{ entry.track.streamIndex !== null ? ` · Stream ${entry.track.streamIndex}` : '' }}</span>
					</div>
					<div class="subtitle-preview-track-details">
						<span v-if="entry.rejectionReasons.length" class="subtitle-preview-rejection">Excluded: {{ entry.rejectionReasons.map(reason => reasons[reason]).join('; ') }}.</span>
						<span v-else>{{ entry.track.id === part.selectedTrackId ? 'Selected' : 'Eligible alternative' }} · Rank {{ entry.rank }}{{ part.outcome === 'credits' ? ' · Ordinary selection replaced by credits' : '' }}</span>
						<span v-if="entry.track.isDefault || entry.track.isForced || entry.track.isHearingImpaired || entry.track.isCommentary" class="subtitle-preview-track-flags">{{ [entry.track.isDefault ? 'Default' : '', entry.track.isForced ? 'Forced' : '', entry.track.isHearingImpaired ? 'Hearing impaired' : '', entry.track.isCommentary ? 'Commentary' : ''].filter(Boolean).join(' · ') }}</span>
					</div>
				</li>
			</ul>
		</section>
	</div>
</template>
