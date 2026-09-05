<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TimelinePreview } from '@moirai/shared';
import { guideDayGeometry, guideSegmentPercent, guideWindowMilliseconds } from '../../guide-geometry';
import { instantLabel } from '../../time-format';
import { programColorStyle } from '../../program-colors';

const props = defineProps<{ preview: TimelinePreview }>();
const selectedIndex = ref(0);
const selected = computed(() => props.preview.segments[selectedIndex.value]);
const windowMilliseconds = computed(() => guideWindowMilliseconds(props.preview.startDate, props.preview.days, props.preview.timeZone));
const ticks = computed(() => {
	const days = guideDayGeometry(props.preview.startDate, props.preview.days, props.preview.timeZone, 1);
	const width = days.reduce((total, day) => total + day.width, 0);
	return days.flatMap((day) => day.ticks.map((tick) => ({
		key: `${day.key}-${tick.hour}`,
		label: `${String(tick.hour).padStart(2, '0')}:00`,
		left: (day.left + tick.left) / width * 100,
	})));
});
watch(() => props.preview, () => {
	selectedIndex.value = 0;
});

/** Show a resolved instant with its calendar date so midnight overruns are unambiguous. */
function timeLabel(instant: string): string {
	return instantLabel(instant, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, props.preview.timeZone);
}

/** Keep in-track time ranges compact while the selected detail retains the calendar date. */
function clockLabel(instant: string): string {
	return instantLabel(instant, { hour: 'numeric', minute: '2-digit' }, props.preview.timeZone);
}
</script>

<template>
	<div class="quick-schedule-sample" aria-label="Sample resolved schedule">
		<p>{{ preview.startDate }} · {{ preview.timeZone }} · Midnight to midnight</p>
		<div class="quick-sample-scroll">
			<div class="quick-sample-ruler" aria-label="Time of day">
				<span v-for="tick in ticks" :key="tick.key" :style="{ left: `${tick.left}%` }">{{ tick.label }}</span>
				<span class="quick-sample-ruler-end">24:00</span>
			</div>
			<div class="resolved-track quick-sample-track">
				<button
					v-for="(segment, index) in preview.segments" :key="segment.id"
					type="button" class="resolved-segment" :class="[`role-${segment.role}`, { 'is-selected': selectedIndex === index, truncated: segment.truncated }]"
					:style="{ ...programColorStyle(segment.programId), flexBasis: `${guideSegmentPercent(segment.start, segment.finish, windowMilliseconds, 0)}%` }"
					:aria-label="`${segment.title}, ${timeLabel(segment.start)} to ${timeLabel(segment.finish)}`"
					:aria-pressed="selectedIndex === index"
					@click="selectedIndex = index" @focus="selectedIndex = index"
				><strong>{{ segment.title }}</strong><small>{{ clockLabel(segment.start) }}–{{ clockLabel(segment.finish) }}</small></button>
			</div>
		</div>
		<p v-if="selected" class="quick-sample-detail" aria-live="polite">
			<strong>{{ selected.title }}</strong>
			<span>{{ timeLabel(selected.start) }} – {{ timeLabel(selected.finish) }}</span>
		</p>
		<p v-else>No resolved items are available yet.</p>
	</div>
</template>
