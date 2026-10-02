<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
	CalendarClock,
	CircleAlert,
	CirclePlus,
	Layers3,
	Pencil,
	Search,
	TvMinimal,
} from '@lucide/vue';
import type { Channel, ChannelSchedule, ScheduleGuide, ScheduleTemplate, SchedulingProgram } from '@moirai/shared';
import { channelLogoUrl } from '../../channel-logo';
import { channelGuideRows } from '../../channel-groups';
import { countLabel } from '../../count-label';
import ResourceEmptyState from '../ResourceEmptyState.vue';
import {
	schedulePredicateSummary,
	scheduleAssignmentName,
	templateRepresentativeStyle,
} from '../../channel-schedule-display';
import type { ScheduleSummaryWindow } from '../../channel-schedule-preview';
import { useGuideSummaries } from '../../guide-summaries';
import type { UpcomingGuideStatus } from '../../upcoming-schedule-guide';
import { schedulingDurationLabel } from '../../schedule-diagnostics';
import { programColorStyle } from '../../program-colors';

const props = defineProps<{
	channels: Channel[];
	schedules: ChannelSchedule[];
	templates: ScheduleTemplate[];
	programs: SchedulingProgram[];
	guide: ScheduleGuide | null;
	summaryWindow: ScheduleSummaryWindow;
	summaryStatus: UpcomingGuideStatus;
}>();

const route = useRoute();
const router = useRouter();
const failedChannelLogos = ref<Set<string>>(new Set());
const { summaries: upcomingSummaries, loading: summariesLoading, error: summariesError } = useGuideSummaries(
	() => props.guide,
	() => props.summaryWindow,
	() => props.summaryStatus === 'ready' || props.summaryStatus === 'stale',
);
const channelSearch = computed(() => {
	const value = route.query.q;
	return typeof value === 'string' ? value : '';
});
const filteredChannels = computed(() => {
	const search = channelSearch.value.trim().toLocaleLowerCase();
	if (!search) {
		return props.channels;
	}

	return props.channels.filter((entry) =>
		[entry.number, entry.name, entry.group ?? ''].some((value) =>
			value.toLocaleLowerCase().includes(search)));
});
const channelRows = computed(() => channelGuideRows(filteredChannels.value));

/** Return the saved schedule associated with a channel. */
function channelSchedule(id: string): ChannelSchedule | undefined {
	return props.schedules.find((schedule) => schedule.channelId === id);
}

/** Return a channel logo unless its most recent image request failed. */
function displayedChannelLogo(channel: Channel): string | null {
	if (failedChannelLogos.value.has(channel.id)) {
		return null;
	}

	return channelLogoUrl(channel);
}

/** Hide a channel logo after its image request fails. */
function markChannelLogoFailed(channelId: string): void {
	failedChannelLogos.value = new Set([...failedChannelLogos.value, channelId]);
}

/** Summarize upcoming 24 hours of programming from the loaded committed guide. */
function nextDaySummary(id: string): string {
	if (!channelSchedule(id)) {
		return 'No programming';
	}

	if (props.summaryStatus === 'loading' || summariesLoading.value) {
		return 'Loading preview…';
	}
	if (props.summaryStatus === 'incomplete') {
		return 'Preview incomplete';
	}
	if (summariesError.value) {
		return 'Preview unavailable';
	}

	const summary = upcomingSummaries.value.get(id);
	if (!summary) {
		return 'Preview unavailable';
	}
	if (summary.gapCount > 0) {
		return `${countLabel(summary.gapCount, 'gap')} · ${schedulingDurationLabel(
			summary.deadAirSeconds,
		)} dead air`;
	}

	const programmed = summary.programmedCount;
	return programmed === 0
		? 'No programming'
		: `${programmed} scheduled item${programmed === 1 ? '' : 's'}`;
}

/** Return whether the upcoming 24-hour window contains dead air for a channel. */
function channelHasDeadAir(id: string): boolean {
	return (upcomingSummaries.value.get(id)?.gapCount ?? 0) > 0;
}

/** Summarize a channel's base and conditional schedule assignments. */
function scheduleStatus(id: string): string {
	const schedule = channelSchedule(id);
	if (!schedule) {
		return 'No schedule configured';
	}

	const layerCount = schedule.layers.length;
	return `${scheduleAssignmentName(
		props.templates,
		props.programs,
		schedule.defaultTemplateId,
		schedule.defaultProgramId,
	)} base${
		layerCount ? ` · ${countLabel(layerCount, 'conditional layer')}` : ''
	}`;
}

/** Color a saved template or direct program assignment. */
function assignmentStyle(templateId: string | null, programId: string | null | undefined): Record<string, string> {
	return programId ? programColorStyle(programId) : templateRepresentativeStyle(props.templates, templateId);
}

/** Label a saved template or direct program assignment. */
function assignmentName(templateId: string | null, programId: string | null | undefined): string {
	return scheduleAssignmentName(props.templates, props.programs, templateId, programId);
}

/** Report the total number of configured schedule layers. */
function stackSummary(id: string): string {
	const schedule = channelSchedule(id);
	if (!schedule) {
		return 'Empty';
	}

	const count = schedule.layers.length + 1;
	return `${count} layer${count === 1 ? '' : 's'}`;
}

/** Merge channel-list controls into route state so browser navigation restores them. */
function updateListQuery(update: Record<string, string | null>, replace = false): void {
	const query: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...route.query, ...update })) {
		if (typeof value === 'string' && value) {
			query[key] = value;
		}
	}

	void router[replace ? 'replace' : 'push']({ path: '/schedules/channels', query });
}

onMounted(() => {
	if ('view' in route.query) {
		updateListQuery({ view: null }, true);
	}
});
</script>

<template>
	<section class="channel-schedules-catalog" aria-labelledby="channel-schedules-count">
		<div class="channel-schedules-catalog-toolbar">
			<strong id="channel-schedules-count">
				{{ filteredChannels.length }} channel{{ filteredChannels.length === 1 ? '' : 's' }}
			</strong>
			<label class="channel-schedules-search">
				<Search :size="20" />
				<input
					type="search"
					aria-label="Search channels"
					placeholder="Search channels…"
					:value="channelSearch"
					@input="updateListQuery({ q: ($event.target as HTMLInputElement).value || null }, true)"
				/>
			</label>
		</div>

		<p v-if="summariesError" class="notice error" role="status">Schedule previews are unavailable. {{ summariesError }}</p>
		<div class="schedule-channel-list">
			<template v-for="row in channelRows" :key="row.key">
				<h3 v-if="row.type === 'family'" class="schedule-channel-family">{{ row.label }}</h3>
				<article
					v-else
					class="schedule-channel-card"
					:class="{ 'has-dead-air': channelHasDeadAir(row.channel.id) }"
				>
					<div class="schedule-channel-card-main">
						<span class="schedule-channel-icon">
							<img
								v-if="displayedChannelLogo(row.channel)"
								:src="displayedChannelLogo(row.channel) ?? undefined"
								alt=""
								loading="lazy"
								decoding="async"
								@error="markChannelLogoFailed(row.channel.id)"
							/>
							<TvMinimal v-else :size="32" />
						</span>
						<div class="schedule-channel-identity">
							<div class="schedule-channel-title">
								<span>{{ row.channel.number }}</span><span aria-hidden="true">·</span
								><strong>{{ row.channel.name }}</strong>
							</div>
							<p>
								<span class="channel-ready-pill">Ready</span>
								<span aria-hidden="true">·</span>
								{{ scheduleStatus(row.channel.id) }}
							</p>
						</div>
						<div class="schedule-channel-metric">
							<Layers3 :size="23" />
							<span><strong>Schedule stack</strong><small>{{ stackSummary(row.channel.id) }}</small></span>
						</div>
						<div class="schedule-channel-metric next-day" :class="{ warning: channelHasDeadAir(row.channel.id) }">
							<CircleAlert v-if="channelHasDeadAir(row.channel.id)" :size="23" />
							<CalendarClock v-else :size="23" />
							<span><strong>Next 24h</strong><small>{{ nextDaySummary(row.channel.id) }}</small></span>
						</div>
					</div>

					<div v-if="!channelSchedule(row.channel.id)" class="schedule-channel-empty-stack">
						<CirclePlus :size="31" />
						<div>
							<strong>Add the first program or template</strong>
							<small>Start by adding a base program or template for this channel.</small>
						</div>
						<RouterLink
							class="button"
							:to="templates.length || programs.length ? `/schedules/channels/${row.channel.id}` : '/schedules/programs/new'"
						>
							{{ templates.length ? 'Add Template' : programs.length ? 'Add Program' : 'Create Program' }}
						</RouterLink>
					</div>
					<div v-else class="schedule-channel-configured-stack">
						<div class="schedule-channel-stack-summary">
							<div
								v-for="layer in channelSchedule(row.channel.id)!.layers.slice(0, 3)"
								:key="layer.id"
								class="schedule-channel-stack-row"
							>
								<i :style="assignmentStyle(layer.templateId, layer.programId)"></i>
								<span>
									<small>Conditional</small>
									<strong>{{ assignmentName(layer.templateId, layer.programId) }}</strong>
									<em>{{ schedulePredicateSummary(layer.predicate) }}</em>
								</span>
							</div>
							<div v-if="channelSchedule(row.channel.id)!.layers.length > 3" class="schedule-channel-stack-more">
								+{{ channelSchedule(row.channel.id)!.layers.length - 3 }} more conditional
								{{ channelSchedule(row.channel.id)!.layers.length - 3 === 1 ? 'template' : 'templates' }}
							</div>
							<div
								class="schedule-channel-stack-row base"
								:class="{ 'base-only': channelSchedule(row.channel.id)!.layers.length === 0 }"
							>
								<i
									:style="assignmentStyle(channelSchedule(row.channel.id)!.defaultTemplateId, channelSchedule(row.channel.id)!.defaultProgramId)"
								></i>
								<span>
									<small>Base</small>
									<strong>{{ assignmentName(channelSchedule(row.channel.id)!.defaultTemplateId, channelSchedule(row.channel.id)!.defaultProgramId) }}</strong>
									<em v-if="channelSchedule(row.channel.id)!.layers.length > 0">Used when no conditional layer supplies programming</em>
								</span>
							</div>
						</div>
						<RouterLink class="button secondary" :to="`/schedules/channels/${row.channel.id}`">
							<Pencil :size="16" />Edit Schedule
						</RouterLink>
					</div>
				</article>
			</template>

			<ResourceEmptyState
				v-if="channels.length === 0"
				title="No channels configured"
				description="Create a channel before building its schedule stack."
				:heading-level="3"
			>
				<template #icon><TvMinimal :size="37" /></template>
				<RouterLink class="button" to="/channels?new=1">Create Channel</RouterLink>
			</ResourceEmptyState>
			<ResourceEmptyState
				v-else-if="filteredChannels.length === 0"
				title="No matching channels"
				description="Try a different channel name or number."
				:heading-level="3"
				compact
			>
				<template #icon><Search :size="35" /></template>
				<button class="button" type="button" @click="updateListQuery({ q: null })">
					Clear Search
				</button>
			</ResourceEmptyState>
		</div>
	</section>
</template>
