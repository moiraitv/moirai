<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, CircleHelp, Clock3, Eye, MoreVertical, Plus, Repeat2, Search, X } from '@lucide/vue';
import { SECONDS_PER_SCHEDULING_DAY, type ScheduleSlot, type ScheduleTemplate } from '@moirai/shared';
import { storeToRefs } from 'pinia';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { templateSlotStyle } from '../channel-schedule-display';
import { errorMessage } from '../error-message';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import TemplateEditor from '../components/templates/TemplateEditor.vue';
import { programColorStyle } from '../program-colors';
import { DISMISSIBLE_HELP_STORAGE_KEYS, useDismissibleHelp } from '../dismissible-help';
import { useChannelsStore } from '../stores/channels';
import { useSchedulingStore } from '../stores/scheduling';
import { scheduleClockLabel } from '../time-format';

const props = withDefaults(defineProps<{ embedded?: boolean; templateId?: string | null }>(), { embedded: false, templateId: null });
const emit = defineEmits<{ close: []; saved: [templateId: string] }>();
const route = useRoute();
const router = useRouter();
const scheduling = useSchedulingStore();
const channelsStore = useChannelsStore();
const { channels } = storeToRefs(channelsStore);
const { visible: templateHelpVisible, dismiss: dismissTemplateHelp, show: showTemplateHelp } = useDismissibleHelp(DISMISSIBLE_HELP_STORAGE_KEYS.templates);
const initialLoading = ref(!(scheduling.loaded && channelsStore.loaded && channelsStore.capabilitiesLoaded));
const error = ref('');
const editing = computed(() => props.embedded ? Boolean(props.templateId) : route.params.id !== undefined);
const templates = computed(() => scheduling.overview?.templates ?? []);
const programs = computed(() => scheduling.overview?.programs ?? []);
const channelSchedules = computed(() => scheduling.overview?.channelSchedules ?? []);
const templateSearch = computed(() => queryText('q'));
const templateChannelFilter = computed(() => queryText('channel') || 'all');
const templatePageSize = computed(() => {
	const value = Number(queryText('pageSize') || 20);
	return [10, 20, 50].includes(value) ? value : 20;
});
const requestedTemplatePage = computed(() => Math.max(1, Number(queryText('page') || 1) || 1));
const filteredTemplates = computed(() => {
	const search = templateSearch.value.trim().toLocaleLowerCase();
	return templates.value.filter((template) => {
		if (search && !template.name.toLocaleLowerCase().includes(search)) {
			return false; 
		}

		const assignments = channelSchedules.value.filter((schedule) => scheduleUsesTemplate(schedule, template.id));
		if (templateChannelFilter.value === 'unassigned') {
			return assignments.length === 0; 
		}

		if (templateChannelFilter.value !== 'all') {
			return assignments.some((schedule) => schedule.channelId === templateChannelFilter.value); 
		}

		return true;
	}).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
});
const templateTotalPages = computed(() => Math.max(1, Math.ceil(filteredTemplates.value.length / templatePageSize.value)));
const templatePage = computed(() => Math.min(requestedTemplatePage.value, templateTotalPages.value));
const visibleTemplates = computed(() => {
	const start = (templatePage.value - 1) * templatePageSize.value;
	return filteredTemplates.value.slice(start, start + templatePageSize.value);
});
const templateRangeStart = computed(() => filteredTemplates.value.length === 0 ? 0 : (templatePage.value - 1) * templatePageSize.value + 1);
const templateRangeEnd = computed(() => Math.min(templatePage.value * templatePageSize.value, filteredTemplates.value.length));

/** Read normalized template search text from route state. */
function queryText(key: string): string {
	const value = route.query[key];
	return typeof value === 'string' ? value : '';
}
/** Merge list controls into route state so browser navigation restores them. */
function updateListQuery(update: Record<string, string | number | null>, replace = false): void {
	const query: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...route.query, ...update })) {
		if (typeof value === 'string' && value) {
			query[key] = value; 
		}
		if (typeof value === 'number' && Number.isFinite(value)) {
			query[key] = String(value); 
		}
	}
	void router[replace ? 'replace' : 'push']({ path: '/schedules/templates', query });
}
/** Return whether a channel uses a template as either its base or a conditional layer. */
function scheduleUsesTemplate(schedule: (typeof channelSchedules.value)[number], templateId: string): boolean {
	return schedule.defaultTemplateId === templateId || schedule.layers.some((layer) => layer.templateId === templateId); 
}
/** Return channel assignments that reference a template. */
function templateAssignments(templateId: string): string[] {
	return channelSchedules.value.filter((schedule) => scheduleUsesTemplate(schedule, templateId)).map((schedule) => schedule.channelId); 
}
/** Summarize template channel for display. */
function templateChannelSummary(templateId: string): string {
	const assignments = templateAssignments(templateId);
	if (assignments.length === 0) {
		return 'Unassigned'; 
	}

	if (assignments.length === 1) {
		return channels.value.find((channel) => channel.id === assignments[0])?.name ?? '1 channel'; 
	}

	return String(assignments.length) + ' channels';
}
/** Resolve a template slot's nominal outgoing boundary. */
function templateSlotEnd(template: ScheduleTemplate, slot: ScheduleSlot): number {
	return template.boundaries.find((boundary) => boundary.leftSlotId === slot.id)?.targetSeconds ?? SECONDS_PER_SCHEDULING_DAY; 
}
/** Return template slots in nominal start-time order. */
function templateSlots(template: ScheduleTemplate): ScheduleSlot[] {
	return [...template.slots].sort((left, right) => left.startSeconds - right.startSeconds); 
}
/** Return the user-facing label for nominal duration. */
function nominalDurationLabel(template: ScheduleTemplate): string {
	const seconds = templateSlots(template).reduce(
		(sum, slot) => sum + Math.max(0, templateSlotEnd(template, slot) - slot.startSeconds),
		0,
	);
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return String(hours) + 'h ' + String(minutes).padStart(2, '0') + 'm nominal';
}
/** Format a template update timestamp as a compact local calendar date. */
function updatedLabel(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return 'Unknown'; 
	}

	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	}).format(parsed);
}
/** Return the display name for program. */
function programName(id: string | null): string {
	if (id === null) {
		return 'No program — fall through';
	}

	return programs.value.find((program) => program.id === id)?.name ?? 'Missing program';
}
/** Return the user-facing label for time. */
function timeLabel(seconds: number): string {
	return scheduleClockLabel(seconds);
}
/** Confirm template deletion and refresh shared scheduling state. */
async function removeTemplate(template: ScheduleTemplate): Promise<void> {
	if (!confirm('Delete ' + template.name + '?')) {
		return; 
	}

	try {
		await api.deleteScheduleTemplate(template.id);
		await scheduling.load();
	}
	catch (cause) {
		error.value = errorMessage(cause); 
	}
}
onMounted(async () => {
	if (!props.embedded && !editing.value && ('sort' in route.query || 'view' in route.query)) {
		updateListQuery({ sort: null, view: null }, true); 
	}
	try {
		await Promise.all([scheduling.load(), channelsStore.loadChannels(), channelsStore.capabilitiesLoaded ? Promise.resolve() : channelsStore.loadCapabilities()]); 
	}
	catch (cause) {
		error.value = errorMessage(cause); 
	}
	finally {
		initialLoading.value = false; 
	}
});
</script>

<template>
	<section class="templates-page">
		<PageHeader
			v-if="!embedded && !editing"
			eyebrow="Daily schedule structures"
			title="Templates"
			description="Allocate programs across a nominal day, then preview duration-aware resolution."
		>
			<button
				v-if="!editing && !templateHelpVisible"
				type="button"
				class="page-help-button"
				aria-label="Show template help"
				@click="showTemplateHelp"
			>
				<CircleHelp :size="20" />
			</button>
			<RouterLink class="button" to="/schedules/templates/new"
			><Plus :size="18" />New template</RouterLink
			>
		</PageHeader>
		<p v-if="!embedded && !editing && (error || scheduling.error)" class="notice error">
			{{ error || scheduling.error }}
		</p>

		<section
			v-if="!embedded && !editing && templateHelpVisible"
			class="templates-intro dismissible-help-panel"
			aria-labelledby="templates-intro-title"
		>
			<button
				type="button"
				class="dismiss-help-button"
				aria-label="Dismiss template help"
				@click="dismissTemplateHelp"
			>
				<X :size="18" />
			</button>
			<div class="templates-intro-copy">
				<div class="templates-intro-icon"><CalendarDays :size="27" /></div>
				<div>
					<h2 id="templates-intro-title">What is a template?</h2>
					<p>
						A template defines how a channel's 24-hour day is structured using reusable schedule
						slots. Reuse templates across channels and dates to keep schedules consistent and easy
						to manage.
					</p>
					<a class="templates-learn-link" href="#templates-help">
						Learn more about templates <ArrowRight :size="18" />
					</a>
				</div>
			</div>
			<div id="templates-help" class="templates-benefits">
				<h2>Templates help you</h2>
				<div class="templates-benefit-grid">
					<article>
						<div class="template-benefit-icon tone-green"><Clock3 :size="24" /></div>
						<h3>Plan a nominal day</h3>
						<p>Allocate time across slots without worrying about actual media durations.</p>
					</article>
					<article>
						<div class="template-benefit-icon tone-blue"><Eye :size="24" /></div>
						<h3>Preview resolution</h3>
						<p>See how slots resolve with real media durations and boundary policies.</p>
					</article>
					<article>
						<div class="template-benefit-icon tone-purple"><Repeat2 :size="24" /></div>
						<h3>Reuse everywhere</h3>
						<p>Use the same template across channels, rotations, and seasons.</p>
					</article>
				</div>
			</div>
		</section>

		<LoadingState v-if="!embedded && !editing && initialLoading" label="Loading templates…" />

		<template v-else-if="!embedded && !editing && scheduling.loaded">
			<section class="templates-catalog" aria-labelledby="your-templates-title">
				<h2 id="your-templates-title">Your templates</h2>
				<div class="templates-catalog-toolbar">
					<label class="template-search-control">
						<Search :size="20" />
						<input
							type="search"
							aria-label="Search templates"
							placeholder="Search templates…"
							:value="templateSearch"
							@input="
								updateListQuery(
									{ q: ($event.target as HTMLInputElement).value || null, page: null },
									true,
								)
							"
						/>
					</label>
					<select
						aria-label="Filter templates by channel"
						:value="templateChannelFilter"
						@change="
							updateListQuery({
								channel:
									($event.target as HTMLSelectElement).value === 'all'
										? null
										: ($event.target as HTMLSelectElement).value,
								page: null,
							})
						"
					>
						<option value="all">All channels</option>
						<option value="unassigned">Unassigned</option>
						<option v-for="channel in channels" :key="channel.id" :value="channel.id">
							{{ channel.number }} · {{ channel.name }}
						</option>
					</select>
				</div>

				<div v-if="visibleTemplates.length" class="templates-list-panel">
					<article v-for="template in visibleTemplates" :key="template.id" class="template-row">
						<span class="template-row-grip" aria-hidden="true">⠿</span>
						<div
							class="template-row-icon"
							:style="programColorStyle(template.slots[0]?.programId ?? null)"
						>
							<CalendarDays :size="23" />
						</div>
						<div class="template-row-identity">
							<RouterLink :to="`/schedules/templates/${template.id}`">{{
								template.name
							}}</RouterLink>
							<small
							>{{ templateChannelSummary(template.id) }} ·
								{{ template.slots.length }} slots</small
							>
						</div>
						<div class="template-row-duration">
							<span>{{ nominalDurationLabel(template) }}</span>
							<small>{{ template.slots.length }} slots</small>
						</div>
						<div
							class="template-mini-track"
							role="img"
							:aria-label="`${template.name} nominal slot structure`"
						>
							<span
								v-for="slot in templateSlots(template)"
								:key="slot.id"
								:class="{ 'fall-through-slot': slot.programId === null }"
								:style="templateSlotStyle(template, slot)"
								:title="`${programName(slot.programId)} · ${timeLabel(slot.startSeconds)}–${timeLabel(templateSlotEnd(template, slot))}`"
							></span>
						</div>
						<div class="template-row-updated">
							<span>Last updated</span>
							<small>{{ updatedLabel(template.updatedAt) }}</small>
						</div>
						<details class="template-row-menu">
							<summary :aria-label="`Actions for ${template.name}`">
								<MoreVertical :size="19" />
							</summary>
							<div>
								<RouterLink :to="`/schedules/templates/${template.id}`">Edit</RouterLink>
								<button type="button" @click="removeTemplate(template)">Delete</button>
							</div>
						</details>
					</article>
					<footer class="templates-pagination">
						<span>
							Showing {{ templateRangeStart }}–{{ templateRangeEnd }} of
							{{ filteredTemplates.length }} templates
						</span>
						<div class="template-page-buttons">
							<button
								type="button"
								aria-label="Previous template page"
								:disabled="templatePage <= 1"
								@click="updateListQuery({ page: templatePage - 1 || null })"
							>
								<ChevronLeft :size="18" />
							</button>
							<button type="button" class="active" aria-current="page">{{ templatePage }}</button>
							<button
								type="button"
								aria-label="Next template page"
								:disabled="templatePage >= templateTotalPages"
								@click="updateListQuery({ page: templatePage + 1 })"
							>
								<ChevronRight :size="18" />
							</button>
						</div>
						<select
							aria-label="Templates per page"
							:value="templatePageSize"
							@change="
								updateListQuery({
									pageSize:
										Number(($event.target as HTMLSelectElement).value) === 20
											? null
											: Number(($event.target as HTMLSelectElement).value),
									page: null,
								})
							"
						>
							<option :value="10">10 per page</option>
							<option :value="20">20 per page</option>
							<option :value="50">50 per page</option>
						</select>
					</footer>
				</div>
				<div v-else class="templates-filter-empty">
					<CalendarDays :size="34" />
					<h3>{{ templates.length ? 'No matching templates' : 'No templates yet' }}</h3>
					<p>
						{{
							templates.length
								? 'Adjust the search or channel filter to see more templates.'
								: 'Create a program, then divide a day into reusable schedule slots.'
						}}
					</p>
				</div>
			</section>

			<aside class="templates-get-started">
				<div class="templates-add-icon"><Plus :size="24" /></div>
				<p>
					<strong>{{ templates.length ? 'Build another structure' : 'Get started' }}</strong>
					<span>Create a template to structure a 24-hour day with reusable schedule slots.</span>
				</p>
				<RouterLink class="toolbar-button" to="/schedules/templates/new">
					{{ templates.length ? 'Create another template' : 'Create your first template' }}
				</RouterLink>
			</aside>
		</template>

		<TemplateEditor
			v-if="editing && !initialLoading"
			:embedded="embedded"
			:template-id="templateId"
			@close="emit('close')"
			@saved="(id) => emit('saved', id)"
		/>
	</section>
</template>
