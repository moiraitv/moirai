<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
	ArrowRight, CalendarDays, CircleHelp, Dices, FileText, Layers3, Lightbulb,
	ListOrdered, Pencil, Plus, Shuffle, Trash2, X, Zap,
} from '@lucide/vue';
import type { SchedulingProgram } from '@moirai/shared';
import { useRoute } from 'vue-router';
import PageHeader from '../components/PageHeader.vue';
import LoadingState from '../components/LoadingState.vue';
import ProgramEditor from '../components/programs/ProgramEditor.vue';
import { countProgramUsages } from '../program-usage';
import { DISMISSIBLE_HELP_STORAGE_KEYS, useDismissibleHelp } from '../dismissible-help';
import { useLibrariesStore } from '../stores/libraries';
import { useSchedulingStore } from '../stores/scheduling';
import { api } from '../api';
import { errorMessage } from '../error-message';

const props = withDefaults(defineProps<{ embedded?: boolean; programId?: string | null }>(), { embedded: false, programId: null });
const emit = defineEmits<{ close: []; saved: [programId: string] }>();
const route = useRoute();
const scheduling = useSchedulingStore();
const librariesStore = useLibrariesStore();
const { visible: programHelpVisible, dismiss: dismissProgramHelp, show: showProgramHelp } = useDismissibleHelp(DISMISSIBLE_HELP_STORAGE_KEYS.programs);
const initialLoading = ref(!(scheduling.loaded && librariesStore.loaded));
const error = ref('');
const editorOpen = computed(() => props.embedded ? Boolean(props.programId) : route.params.id !== undefined);
const programs = computed(() => scheduling.overview?.programs ?? []);
const statuses = computed(() => new Map((scheduling.overview?.programStatuses ?? []).map((status) => [status.programId, status])));
const usages = computed(() => countProgramUsages(scheduling.overview));
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
/** Confirm and delete a program that is not in use. */
async function remove(program: SchedulingProgram): Promise<void> {
	if (!confirm('Delete ' + program.name + '?')) {
		return; 
	}

	try {
		await api.deleteProgram(program.id);
		await scheduling.load();
	}
	catch (cause) {
		error.value = errorMessage(cause); 
	}
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
			<button
				v-if="!programHelpVisible"
				type="button"
				class="page-help-button"
				aria-label="Show program help"
				@click="showProgramHelp"
			>
				<CircleHelp :size="20" />
			</button>
			<RouterLink class="button programs-primary-button" to="/schedules/programs/new"
			><Plus :size="18" />New program</RouterLink
			>
		</PageHeader>
		<p v-if="!embedded && !editorOpen && (error || scheduling.error)" class="notice error">
			{{ error || scheduling.error }}
		</p>

		<section
			v-if="!embedded && !editorOpen && programHelpVisible"
			class="programs-intro dismissible-help-panel"
			aria-labelledby="programs-intro-title"
		>
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
						Learn more about programs <ArrowRight :size="18" />
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

		<LoadingState v-if="!embedded && !editorOpen && initialLoading" label="Loading programs…" />
		<template v-else-if="!embedded && !editorOpen && scheduling.loaded">
			<div v-if="programs.length" class="schedule-card-grid programs-resource-grid">
				<article v-for="program in programs" :key="program.id" class="schedule-resource-card">
					<div>
						<span class="status-dot" :class="`health-${healthLabel(program)}`"></span
						><small>{{ program.config.type }}</small>
					</div>
					<h2>{{ program.name }}</h2>
					<p>{{ statuses.get(program.id)?.sourceLabel }}</p>
					<small
					>{{ statuses.get(program.id)?.availableItemCount ?? 0 }} playable ·
						{{ usages.get(program.id) ?? 0 }} uses</small
					>
					<div class="card-actions">
						<RouterLink
							class="icon-button"
							:to="`/schedules/programs/${program.id}`"
							:aria-label="`Edit ${program.name}`"
						><Pencil :size="16"
						/></RouterLink>
						<button
							class="icon-button danger-icon"
							:aria-label="`Delete ${program.name}`"
							@click="remove(program)"
						>
							<Trash2 :size="16" />
						</button>
					</div>
				</article>
			</div>
			<div v-else class="programs-empty-state">
				<div class="programs-empty-icon" aria-hidden="true">
					<ListOrdered :size="37" />
					<Zap class="programs-empty-zap" :size="23" />
				</div>
				<h2>No programs yet</h2>
				<p>
					Create a program to define how media should be selected and arranged.<br />You can reuse
					it in any schedule slot.
				</p>
				<RouterLink class="button programs-empty-action" to="/schedules/programs/new">
					<Plus :size="19" />Create your first program
				</RouterLink>
				<a class="programs-example-link" href="#program-types" @click="showProgramHelp">
					<FileText :size="17" />Browse example programs
				</a>
			</div>
		</template>

		<aside v-if="!embedded && !editorOpen" class="programs-tip">
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
