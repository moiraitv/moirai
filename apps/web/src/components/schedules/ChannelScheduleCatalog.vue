<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
	CalendarClock,
	CirclePlus,
	Layers3,
	Pencil,
	Search,
	TvMinimal,
} from '@lucide/vue';
import type { Channel, ChannelSchedule, ScheduleGuide, ScheduleTemplate } from '@moirai/shared';
import { channelLogoUrl } from '../../channel-logo';
import ResourceEmptyState from '../ResourceEmptyState.vue';
import {
	schedulePredicateSummary,
	scheduleTemplateName,
	templateRepresentativeStyle,
} from '../../channel-schedule-display';
import { dateKey } from '../../date-key';

const props = defineProps<{
	channels: Channel[];
	schedules: ChannelSchedule[];
	templates: ScheduleTemplate[];
	guide: ScheduleGuide | null;
}>();

const route = useRoute();
const router = useRouter();
const failedChannelLogos = ref<Set<string>>(new Set());
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

/** Summarize next-day programming from the loaded committed guide. */
function nextDaySummary(id: string): string {
	if (!channelSchedule(id)) {
		return 'No programming';
	}

	const preview = props.guide?.channels.find((entry) => entry.channelId === id)?.preview;
	if (!preview) {
		return 'Preview unavailable';
	}

	const programmed = preview.segments.filter(
		(segment) =>
			segment.role !== 'dead-air'
			&& dateKey(new Date(segment.start), preview.timeZone) === preview.startDate,
	).length;
	return programmed === 0
		? 'No programming'
		: `${programmed} scheduled item${programmed === 1 ? '' : 's'}`;
}

/** Summarize a channel's base and conditional template configuration. */
function scheduleStatus(id: string): string {
	const schedule = channelSchedule(id);
	if (!schedule) {
		return 'No schedule configured';
	}

	const layerCount = schedule.layers.length;
	return `${scheduleTemplateName(props.templates, schedule.defaultTemplateId)} base${layerCount ? ` · ${layerCount} conditional` : ''}`;
}

/** Report the total number of configured template layers. */
function stackSummary(id: string): string {
	const schedule = channelSchedule(id);
	if (!schedule) {
		return 'Empty';
	}

	const count = schedule.layers.length + 1;
	return `${count} template${count === 1 ? '' : 's'}`;
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

		<div class="schedule-channel-list">
			<article v-for="entry in filteredChannels" :key="entry.id" class="schedule-channel-card">
				<div class="schedule-channel-card-main">
					<span class="schedule-channel-icon">
						<img
							v-if="displayedChannelLogo(entry)"
							:src="displayedChannelLogo(entry) ?? undefined"
							alt=""
							loading="lazy"
							decoding="async"
							@error="markChannelLogoFailed(entry.id)"
						/>
						<TvMinimal v-else :size="32" />
					</span>
					<div class="schedule-channel-identity">
						<div class="schedule-channel-title">
							<span>{{ entry.number }}</span><span aria-hidden="true">·</span
							><strong>{{ entry.name }}</strong>
						</div>
						<p>
							<span class="channel-ready-pill">Ready</span>
							<span aria-hidden="true">·</span>
							{{ scheduleStatus(entry.id) }}
						</p>
					</div>
					<div class="schedule-channel-metric">
						<Layers3 :size="23" />
						<span><strong>Template stack</strong><small>{{ stackSummary(entry.id) }}</small></span>
					</div>
					<div class="schedule-channel-metric next-day">
						<CalendarClock :size="23" />
						<span><strong>Next 24h</strong><small>{{ nextDaySummary(entry.id) }}</small></span>
					</div>
				</div>

				<div v-if="!channelSchedule(entry.id)" class="schedule-channel-empty-stack">
					<CirclePlus :size="31" />
					<div>
						<strong>Add the first template</strong>
						<small>Start by adding a base template for this channel.</small>
					</div>
					<RouterLink
						class="button"
						:to="templates.length ? `/schedules/channels/${entry.id}` : '/schedules/templates/new'"
					>
						{{ templates.length ? 'Add Template' : 'Create Template' }}
					</RouterLink>
				</div>
				<div v-else class="schedule-channel-configured-stack">
					<div class="schedule-channel-stack-summary">
						<div
							v-for="layer in channelSchedule(entry.id)!.layers.slice(0, 3)"
							:key="layer.id"
							class="schedule-channel-stack-row"
						>
							<i :style="templateRepresentativeStyle(templates, layer.templateId)"></i>
							<span>
								<small>Conditional</small>
								<strong>{{ scheduleTemplateName(templates, layer.templateId) }}</strong>
								<em>{{ schedulePredicateSummary(layer.predicate) }}</em>
							</span>
						</div>
						<div v-if="channelSchedule(entry.id)!.layers.length > 3" class="schedule-channel-stack-more">
							+{{ channelSchedule(entry.id)!.layers.length - 3 }} more conditional templates
						</div>
						<div class="schedule-channel-stack-row base">
							<i
								:style="templateRepresentativeStyle(templates, channelSchedule(entry.id)!.defaultTemplateId)"
							></i>
							<span>
								<small>Base</small>
								<strong>{{ scheduleTemplateName(templates, channelSchedule(entry.id)!.defaultTemplateId) }}</strong>
								<em>Used when no conditional layer supplies programming</em>
							</span>
						</div>
					</div>
					<RouterLink class="button secondary" :to="`/schedules/channels/${entry.id}`">
						<Pencil :size="16" />Edit Schedule
					</RouterLink>
				</div>
			</article>

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
