<script setup lang="ts">
import { computed } from 'vue';
import { RefreshCw } from '@lucide/vue';
import type { ProgramConfig, TimelineSegment } from '@moirai/shared';
import { useSequencePreview } from '../../composables/useSequencePreview';
import { guideDayGeometry } from '../../guide-geometry';
import { PROGRAM_COLOR_PALETTE } from '../../program-colors';
import { instantLabel } from '../../time-format';
import { randomUuid } from '../../random-uuid';

const props = defineProps<{ config: ProgramConfig; programId?: string | undefined; programNames: Map<string, string> }>();
const draftId = randomUuid();
const { preview, updating, queued, stale, error, invalid, refresh } = useSequencePreview(() => props.config, () => props.programId ?? draftId);
const entries = computed(() => props.config.type === 'sequence' ? props.config.entries : []);
const geometry = computed(() => preview.value
	? guideDayGeometry(preview.value.startDate, 1, preview.value.timeZone, 1)[0]! : null);
const hours = computed(() => geometry.value?.width ?? 24);
const legend = computed(() => entries.value.map((entry, index) => ({
	id: entry.id, number: index + 1, name: props.programNames.get(entry.programId) ?? 'Missing Program',
	color: PROGRAM_COLOR_PALETTE[index % PROGRAM_COLOR_PALETTE.length]!,
})));

/** Resolve the top-level step even when repeated references share a child Program. */
function step(segment: TimelineSegment) {
	return legend.value.find(entry => entry.id === segment.sequenceEntryPath?.[0]);
}

/** Place segments by elapsed time and visually clip overrun at the end of the sample day. */
function segmentStyle(segment: TimelineSegment): Record<string, string> {
	const day = geometry.value!;
	const start = Math.max(day.startMilliseconds, Date.parse(segment.start));
	const finish = Math.min(day.finishMilliseconds, Date.parse(segment.finish));
	const duration = day.finishMilliseconds - day.startMilliseconds;
	const color = step(segment)?.color;
	return {
		left: `${(start - day.startMilliseconds) / duration * 100}%`,
		width: `${Math.max(0, finish - start) / duration * 100}%`,
		...(color ? { background: `linear-gradient(135deg, ${color.solid}, ${color.dark})`, color: color.foreground } : {}),
	};
}

/** Format actual sample times in the configured scheduling zone. */
function timeRange(segment: TimelineSegment): string {
	const options = { hour: 'numeric', minute: '2-digit' } as const;
	return `${instantLabel(segment.start, options, preview.value?.timeZone)}–${instantLabel(segment.finish, options, preview.value?.timeZone)}`;
}

/** Accessible full title remains available when a short block clips its visible text. */
function segmentLabel(segment: TimelineSegment): string {
	const entry = step(segment);
	return `${entry ? `Entry ${entry.number}: ${entry.name} · ` : ''}${segment.title} · ${timeRange(segment)}`;
}
</script>

<template>
	<section class="sequence-guide-preview" aria-label="Sequence guide preview">
		<div class="sequence-guide-heading">
			<h3>Guide preview</h3>
			<button type="button" class="icon-button" aria-label="Refresh guide preview" title="Refresh guide preview" :disabled="updating || invalid" @click="refresh()">
				<RefreshCw :size="16" :class="{ spinning: updating }" aria-hidden="true" />
			</button>
		</div>
		<p>Sample day starting with fresh sequence and child progress. Four hours visible; scroll horizontally to explore the day.</p>
		<p v-if="invalid" class="notice">Add valid steps and counts to preview this sequence.</p>
		<p v-else-if="error" class="notice error" role="alert">{{ error }}</p>
		<p v-else-if="updating || queued" role="status">{{ preview ? 'Updating sample…' : 'Loading sample…' }}</p>
		<p v-if="stale && preview" class="sequence-preview-stale">Previous sample — scheduling changes are not shown yet.</p>
		<div class="sequence-guide-scroll" tabindex="0" role="region" aria-label="Sample day timeline, scroll horizontally" :aria-busy="updating || queued">
			<div class="sequence-guide-day" :style="{ width: `${hours / 4 * 100}%` }">
				<div class="sequence-guide-ruler" aria-hidden="true">
					<span v-for="tick in geometry?.ticks ?? []" :key="tick.left" :style="{ left: `${tick.left / hours * 100}%` }">{{ String(tick.hour).padStart(2, '0') }}:00</span>
				</div>
				<div class="sequence-guide-track">
					<div
						v-for="segment in preview?.segments ?? []" :key="segment.id" class="sequence-guide-segment" :class="{ 'is-gap': segment.role === 'dead-air' }"
						:style="segmentStyle(segment)" :data-entry-id="segment.sequenceEntryPath?.[0]" tabindex="0" :title="segmentLabel(segment)" :aria-label="segmentLabel(segment)">
						<strong>{{ step(segment) ? `${step(segment)!.number}. ` : '' }}{{ segment.title }}</strong>
						<small>{{ timeRange(segment) }}</small>
					</div>
				</div>
			</div>
		</div>
		<ol class="sequence-guide-legend" aria-label="Sequence entry colors">
			<li v-for="entry in legend" :key="entry.id"><span :style="{ background: entry.color.solid }" aria-hidden="true" />{{ entry.number }}. {{ entry.name }}</li>
		</ol>
		<div v-if="preview?.issues.length" class="sequence-preview-issues">
			<p v-for="(issue, index) in preview.issues" :key="index" class="notice">{{ issue.message }}</p>
		</div>
	</section>
</template>
