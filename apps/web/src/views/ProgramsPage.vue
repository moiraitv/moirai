<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
	ArrowRight, CalendarDays, ChevronLeft, ChevronRight, CircleHelp, Dices, FileText,
	Layers3, Lightbulb, ListOrdered, Plus, Search, Shuffle, X, Zap,
} from '@lucide/vue';
import type { SchedulingProgram } from '@moirai/shared';
import { useRoute, useRouter } from 'vue-router';
import PageHeader from '../components/PageHeader.vue';
import AnimatedHelpPanel from '../components/AnimatedHelpPanel.vue';
import LoadingState from '../components/LoadingState.vue';
import MediaCardPreview from '../components/MediaCardPreview.vue';
import ProgramEditor from '../components/programs/ProgramEditor.vue';
import ResourceEmptyState from '../components/ResourceEmptyState.vue';
import { countProgramUsages } from '../program-usage';
import { DISMISSIBLE_HELP_STORAGE_KEYS, useDismissibleHelp } from '../dismissible-help';
import { useLibrariesStore } from '../stores/libraries';
import { useSchedulingStore } from '../stores/scheduling';
import { errorMessage } from '../error-message';
import { artworkSrcset, artworkVariantUrl } from '../artwork-url';
import { hideBrokenImage } from '../image-error';
import { countLabel } from '../count-label';

/** TODO: Enable once the Programs catalog tip has been populated with finalized guidance. */
const programsTipVisible = false;

const props = withDefaults(defineProps<{ embedded?: boolean; programId?: string | null }>(), { embedded: false, programId: null });
const emit = defineEmits<{ close: []; saved: [programId: string] }>();
const route = useRoute();
const router = useRouter();
const scheduling = useSchedulingStore();
const librariesStore = useLibrariesStore();
const { visible: programHelpVisible, dismiss: dismissProgramHelp, show: showProgramHelp } = useDismissibleHelp(DISMISSIBLE_HELP_STORAGE_KEYS.programs);
const initialLoading = ref(!(scheduling.loaded && librariesStore.loaded));
const error = ref('');
const editorOpen = computed(() => props.embedded ? Boolean(props.programId) : route.params.id !== undefined);
const programs = computed(() => scheduling.overview?.programs ?? []);
const statuses = computed(() => new Map((scheduling.overview?.programStatuses ?? []).map((status) => [status.programId, status])));
const usages = computed(() => countProgramUsages(scheduling.overview));
const programById = computed(() => new Map(programs.value.map((program) => [program.id, program])));
const programSearch = computed(() => queryText('q'));
const programTypeFilter = computed(() => queryText('type') || 'all');
const programPageSize = computed(() => {
	const value = Number(queryText('pageSize') || 20);
	return [10, 20, 50].includes(value) ? value : 20;
});
const requestedProgramPage = computed(() => Math.max(1, Number(queryText('page') || 1) || 1));
const filteredPrograms = computed(() => {
	const search = programSearch.value.trim().toLocaleLowerCase();
	return programs.value.filter((program) => {
		if (programTypeFilter.value !== 'all' && program.config.type !== programTypeFilter.value) {
			return false;
		}

		const source = statuses.value.get(program.id)?.sourceLabel ?? '';
		return !search || `${program.name} ${source}`.toLocaleLowerCase().includes(search);
	}).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
});
const programTotalPages = computed(() => Math.max(1, Math.ceil(filteredPrograms.value.length / programPageSize.value)));
const programPage = computed(() => Math.min(requestedProgramPage.value, programTotalPages.value));
const visiblePrograms = computed(() => {
	const start = (programPage.value - 1) * programPageSize.value;
	return filteredPrograms.value.slice(start, start + programPageSize.value);
});
const programRangeStart = computed(() => filteredPrograms.value.length === 0 ? 0 : (programPage.value - 1) * programPageSize.value + 1);
const programRangeEnd = computed(() => Math.min(programPage.value * programPageSize.value, filteredPrograms.value.length));
const programExamples = [
	{ title: 'Shuffle Movies', description: 'Random movies with no repeats until all play', icon: Shuffle, tone: 'green' },
	{ title: 'Sequential Shows', description: 'Play episodes in order, continuing where you left off', icon: ListOrdered, tone: 'blue' },
	{ title: 'Mixed Sequence', description: 'Combine shows, movies, and more in a custom order', icon: Layers3, tone: 'purple' },
	{ title: 'Random Anything', description: 'Random from any collection or library query', icon: Dices, tone: 'orange' },
];

/** Return the user-facing label for health. */
function healthLabel(program: SchedulingProgram): string {
	return statuses.value.get(program.id)?.health ?? 'empty';
}

/** Read normalized program catalog state from the route query. */
function queryText(key: string): string {
	const value = route.query[key];
	return typeof value === 'string' ? value : '';
}

/** Merge program catalog controls into route state for browser navigation. */
function updateListQuery(update: Record<string, string | number | null>, replace = false): void {
	const query: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...route.query, ...update })) {
		if (typeof value === 'string' && value) {
			query[key] = value;
		}
		else if (typeof value === 'number' && Number.isFinite(value)) {
			query[key] = String(value);
		}
	}

	void router[replace ? 'replace' : 'push']({ query });
}

/** Open a program when its row surface, rather than a nested control, is clicked. */
function openProgramRow(event: MouseEvent, programId: string): void {
	const target = event.target;
	if (!(target instanceof Element) || target.closest('a, button, input, select, textarea')) {
		return;
	}

	void router.push(`/schedules/programs/${programId}`);
}

/** Return the child program represented by one sequence entry. */
function childProgram(programId: string): SchedulingProgram | undefined {
	return programById.value.get(programId);
}

/** Return the number of indexed items omitted from a program's bounded preview. */
function remainingPreviewCount(programId: string): number {
	const status = statuses.value.get(programId);
	return Math.max(0, (status?.indexedItemCount ?? 0) - (status?.previewItems.length ?? 0));
}
onMounted(async () => {
	try {
		await Promise.all([scheduling.load(), librariesStore.load()]); 
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
	<section class="programs-page">
		<PageHeader
			v-if="!embedded && !editorOpen"
			eyebrow="Reusable content rules"
			title="Programs"
			description="Programs define how eligible media is selected and arranged. Reuse them across multiple schedules and channels."
		>
			<Transition name="context-popover">
				<button
					v-if="!programHelpVisible"
					type="button"
					class="page-help-button"
					aria-label="Show program help"
					@click="showProgramHelp"
				>
					<CircleHelp :size="20" />
				</button>
			</Transition>
			<RouterLink class="button programs-primary-button" to="/schedules/programs/new"
			><Plus :size="18" />New Program</RouterLink
			>
		</PageHeader>
		<p v-if="!embedded && !editorOpen && (error || scheduling.error)" class="notice error">
			{{ error || scheduling.error }}
		</p>

		<AnimatedHelpPanel :visible="!embedded && !editorOpen && programHelpVisible">
			<section class="programs-intro dismissible-help-panel" aria-labelledby="programs-intro-title">
				<button
					type="button"
					class="dismiss-help-button"
					aria-label="Dismiss program help"
					@click="dismissProgramHelp"
				>
					<X :size="18" />
				</button>
				<div class="programs-intro-copy">
					<div class="programs-intro-icon"><CalendarDays :size="27" /></div>
					<div>
						<h2 id="programs-intro-title">What is a program?</h2>
						<p>
							A program is a reusable rule that tells Moirai what content to play and in what order.
							Use programs in your schedule slots to build your channel lineup.
						</p>
						<a class="programs-learn-link" href="#program-types">
							Learn More About Programs <ArrowRight :size="18" />
						</a>
					</div>
				</div>
				<div id="program-types" class="programs-types">
					<h2>Common program types</h2>
					<div class="program-type-grid">
						<article v-for="example in programExamples" :key="example.title">
							<div class="program-type-icon" :class="`tone-${example.tone}`">
								<component :is="example.icon" :size="26" />
							</div>
							<h3>{{ example.title }}</h3>
							<p>{{ example.description }}</p>
						</article>
					</div>
				</div>
			</section>
		</AnimatedHelpPanel>

		<LoadingState v-if="!embedded && !editorOpen && initialLoading" label="Loading programs…" />
		<template v-else-if="!embedded && !editorOpen && scheduling.loaded">
			<section class="programs-catalog async-state-surface" aria-labelledby="your-programs-title">
				<h2 id="your-programs-title">Your programs</h2>
				<div class="programs-catalog-toolbar">
					<label class="program-search-control"><Search :size="20" /><input type="search" aria-label="Search programs" placeholder="Search programs…" :value="programSearch" @input="updateListQuery({ q: ($event.target as HTMLInputElement).value || null, page: null }, true)" /></label>
					<select aria-label="Filter programs by type" :value="programTypeFilter" @change="updateListQuery({ type: ($event.target as HTMLSelectElement).value === 'all' ? null : ($event.target as HTMLSelectElement).value, page: null })"><option value="all">All program types</option><option value="content">Content</option><option value="sequence">Sequence</option></select>
				</div>

				<div v-if="visiblePrograms.length" class="programs-list-panel">
					<article v-for="program in visiblePrograms" :key="program.id" class="program-row" @click="openProgramRow($event, program.id)">
						<div class="program-row-heading"><span class="status-dot" :class="`health-${healthLabel(program)}`"></span><div><RouterLink :to="`/schedules/programs/${program.id}`">{{ program.name }}</RouterLink><small>{{ program.config.type }} · {{ statuses.get(program.id)?.sourceLabel }}</small></div><span class="program-row-counts">{{ statuses.get(program.id)?.availableItemCount ?? 0 }}/{{ statuses.get(program.id)?.indexedItemCount ?? 0 }} playable · {{ countLabel(usages.get(program.id) ?? 0, 'use') }}</span><RouterLink class="icon-button program-row-menu" :to="`/schedules/programs/${program.id}`" :aria-label="`Edit ${program.name}`"><ChevronRight :size="18" /></RouterLink></div>
						<div v-if="program.config.type === 'content'" class="program-carousel" :aria-label="`${program.name} media preview`">
							<MediaCardPreview v-for="item in statuses.get(program.id)?.previewItems ?? []" :key="item.id" :item="item" class="program-carousel-preview">
								<RouterLink :to="`/libraries/${item.libraryId}/items/${item.id}`" class="program-carousel-card" :class="{ unavailable: item.availability !== 'available' }"><span><img v-if="item.artworkUrl" :src="artworkVariantUrl(item.artworkUrl, 'thumb')" :srcset="artworkSrcset(item.artworkUrl, 'thumb')" alt="" loading="lazy" @error="hideBrokenImage" /><FileText v-else :size="23" /></span><strong>{{ item.title }}</strong><small>{{ item.year ?? 'Year unknown' }}</small><em v-if="item.availability !== 'available'">Unavailable</em></RouterLink>
							</MediaCardPreview>
							<article v-if="remainingPreviewCount(program.id)" class="program-carousel-more"><span><Plus :size="26" /></span><strong>{{ remainingPreviewCount(program.id).toLocaleString() }} more</strong><small>{{ remainingPreviewCount(program.id) === 1 ? 'matching item' : 'matching items' }}</small></article>
							<p v-if="!(statuses.get(program.id)?.previewItems.length)">No indexed media matches this program.</p>
						</div>
						<div v-else class="program-carousel sequence-carousel" :aria-label="`${program.name} child programs`">
							<template v-for="entry in program.config.entries" :key="entry.id">
								<RouterLink v-if="childProgram(entry.programId)" :to="`/schedules/programs/${entry.programId}`" class="program-carousel-card"><span><Layers3 :size="23" /></span><strong>{{ childProgram(entry.programId)?.name }}</strong><small>{{ entry.count.toLocaleString() }} {{ entry.count === 1 ? 'item' : 'items' }}</small></RouterLink>
								<article v-else class="unavailable"><span><Layers3 :size="23" /></span><strong>Missing program</strong><small>{{ entry.count.toLocaleString() }} {{ entry.count === 1 ? 'item' : 'items' }}</small></article>
							</template>
							<p v-if="program.config.entries.length === 0">No child programs in this sequence.</p>
						</div>
					</article>
					<footer class="programs-pagination"><span>Showing {{ programRangeStart }}–{{ programRangeEnd }} of {{ countLabel(filteredPrograms.length, 'program') }}</span><div class="program-page-buttons"><button type="button" aria-label="Previous program page" :disabled="programPage <= 1" @click="updateListQuery({ page: programPage - 1 || null })"><ChevronLeft :size="18" /></button><button type="button" class="active" aria-current="page">{{ programPage }}</button><button type="button" aria-label="Next program page" :disabled="programPage >= programTotalPages" @click="updateListQuery({ page: programPage + 1 })"><ChevronRight :size="18" /></button></div><select aria-label="Programs per page" :value="programPageSize" @change="updateListQuery({ pageSize: Number(($event.target as HTMLSelectElement).value) === 20 ? null : Number(($event.target as HTMLSelectElement).value), page: null })"><option :value="10">10 per page</option><option :value="20">20 per page</option><option :value="50">50 per page</option></select></footer>
				</div>
				<ResourceEmptyState
					v-else
					:title="programs.length ? 'No matching programs' : 'No programs yet'"
					:description="programs.length
						? 'Adjust the search or type filter to see more programs.'
						: 'Create a program to define how media should be selected and arranged. You can reuse it in any schedule slot.'"
					:heading-level="3"
					:compact="programs.length > 0"
				>
					<template #icon>
						<ListOrdered :size="37" />
						<Zap class="programs-empty-zap" :size="23" />
					</template>
					<button
						v-if="programs.length"
						class="button"
						type="button"
						@click="updateListQuery({ q: null, type: null, page: null })"
					>
						Clear Filters
					</button>
					<RouterLink v-else class="button" to="/schedules/programs/new">
						<Plus :size="19" />Create Your First Program
					</RouterLink>
					<template #secondary>
						<RouterLink v-if="programs.length" to="/schedules/programs/new">
							<Plus :size="17" />New Program
						</RouterLink>
						<a v-else href="#program-types" @click="showProgramHelp">
							<FileText :size="17" />Browse example programs
						</a>
					</template>
				</ResourceEmptyState>
			</section>
		</template>

		<aside v-if="programsTipVisible && !embedded && !editorOpen" class="programs-tip">
			<div><Lightbulb :size="21" /></div>
			<p>
				<strong>Tip</strong>
				<span
				>Build once, use everywhere. Attach programs to slots in your schedules to create
					consistent, maintainable channel lineups.</span
				>
			</p>
		</aside>

		<ProgramEditor
			v-if="editorOpen && !initialLoading"
			:embedded="embedded"
			:program-id="programId"
			@close="emit('close')"
			@saved="(id) => emit('saved', id)"
		/>
	</section>
</template>
