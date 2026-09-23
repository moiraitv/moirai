<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { Plus, ListOrdered } from '@lucide/vue';
import type { SchedulingProgram } from '@moirai/shared';
import { useRoute, useRouter } from 'vue-router';
import PageHeader from '../components/PageHeader.vue';
import LoadingState from '../components/LoadingState.vue';
import ResourceEmptyState from '../components/ResourceEmptyState.vue';
import ProgramEditor from '../components/programs/ProgramEditor.vue';
import ProgramCatalogToolbar from '../components/programs/ProgramCatalogToolbar.vue';
import ProgramCatalogList from '../components/programs/ProgramCatalogList.vue';
import ProgramInspector from '../components/programs/ProgramInspector.vue';
import { filterPrograms } from '../components/programs/program-catalog';
import { confirmProgramDeletion } from '../components/programs/program-resource-actions';
import { liveEvents } from '../live-events';
import { countProgramUsages } from '../program-usage';
import { useLibrariesStore } from '../stores/libraries';
import { useSchedulingStore } from '../stores/scheduling';
import { api } from '../api';
import { errorMessage } from '../error-message';

const props = withDefaults(defineProps<{ embedded?: boolean; programId?: string | null }>(), { embedded: false, programId: null });
const emit = defineEmits<{ close: []; saved: [programId: string] }>();
const route = useRoute();
const router = useRouter();
const scheduling = useSchedulingStore();
const librariesStore = useLibrariesStore();
const initialLoading = ref(!(scheduling.loaded && librariesStore.loaded));
const error = ref('');
const deleting = ref(false);
const workspace = ref<HTMLElement>();
const workspaceHeight = ref('');
let resizeObserver: ResizeObserver | undefined;
const list = ref<InstanceType<typeof ProgramCatalogList>>();
const editorOpen = computed(() => props.embedded ? Boolean(props.programId) : route.params.id !== undefined);
const modal = ref(window.matchMedia('(max-width: 1220px)').matches);
const media = window.matchMedia('(max-width: 1220px)');
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshPending = false;
let refreshing = false;
let disposed = false;
/** Coalesce live progress so a batch of embeddings cannot trigger overlapping overview reads. */
function refreshOverview(): void {
	refreshPending = true;
	if (disposed || refreshTimer || refreshing) {
		return;
	}
	refreshTimer = setTimeout(async () => {
		refreshTimer = undefined;
		refreshPending = false;
		refreshing = true;
		try {
			await scheduling.load();
		}
		finally {
			refreshing = false;
			if (refreshPending && !disposed) {
				refreshOverview();
			}
		}
	}, 1_000);
}
const unsubscribeEmbeddingProgress = liveEvents.subscribe((event) => {
	if (event.type === 'embeddings.changed' || event.type === 'timeline.changed') {
		refreshOverview();
	}
});
onUnmounted(() => {
	disposed = true;
	clearTimeout(refreshTimer);
	unsubscribeEmbeddingProgress();
});

const programs = computed(() => scheduling.overview?.programs ?? []);
const statuses = computed(() => new Map((scheduling.overview?.programStatuses ?? []).map(status => [status.programId, status])));
const usages = computed(() => countProgramUsages(scheduling.overview));
const programById = computed(() => new Map(programs.value.map(program => [program.id, program])));
const filters = computed(() => ({ q: queryText('q'), type: queryText('type'), subtype: queryText('subtype'), usage: queryText('usage'), sort: queryText('sort') }));
const filtered = computed(() => filterPrograms(programs.value, statuses.value, usages.value, filters.value));
const selectedId = computed(() => queryText('selected'));
const selected = computed(() => programById.value.get(selectedId.value));

/** Read only scalar query values from shared router state. */
function queryText(key: string): string {
	const value = route.query[key];
	return typeof value === 'string' ? value : '';
}
/** Persist controls while retiring the previous client-side pagination state. */
function updateQuery(update: Record<string, string | null>, replace = false): void {
	const query = { ...route.query, ...update };
	delete query.page;
	delete query.pageSize;
	for (const key of Object.keys(update)) {
		if (!query[key] || (['type', 'subtype', 'usage'].includes(key) && query[key] === 'all')) {
			delete query[key];
		}
	}
	void router[replace ? 'replace' : 'push']({ query });
}
/** Select a Program without changing the full-editor route contract. */
function selectProgram(id: string): void {
	updateQuery({ selected: id });
}
/** Dismiss inspection and restore a virtualized selection's keyboard target. */
async function closeInspector(): Promise<void> {
	const id = selectedId.value;
	await router.push({ query: { ...route.query, selected: undefined } });
	await nextTick();
	if (list.value) {
		await list.value.focusProgram(id);
	}
	else {
		document.querySelector<HTMLInputElement>('.program-management-toolbar input')?.focus();
	}
}
/** Fit the two scroll surfaces below the actual header, including application notices. */
function measureWorkspace(): void {
	if (workspace.value) {
		workspaceHeight.value = `${Math.max(320, window.innerHeight - workspace.value.getBoundingClientRect().top - 20)}px`;
	}
}
watch(workspace, element => {
	resizeObserver?.disconnect();
	if (element) {
		measureWorkspace();
		resizeObserver = new ResizeObserver(measureWorkspace);
		const header = element.previousElementSibling;
		if (header) {
			resizeObserver.observe(header);
		}
	}
});
/** Keep modal semantics aligned with the CSS presentation breakpoint. */
function updateViewport(): void {
	modal.value = media.matches;
}
/** Delete after inline confirmation or request the standard resource confirmation. */
async function deleteProgram(program: SchedulingProgram, confirmed = false): Promise<void> {
	if (deleting.value) {
		return;
	}
	deleting.value = true;
	error.value = '';
	try {
		if (confirmed) {
			await api.deleteProgram(program.id);
		}
		if (confirmed || await confirmProgramDeletion(program)) {
			await scheduling.load();
			if (selectedId.value === program.id) {
				await closeInspector();
			}
		}
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		deleting.value = false;
	}
}
/** Load the shared overview and library names before making absence claims. */
async function load(): Promise<void> {
	error.value = '';
	try {
		await Promise.all([scheduling.load(), librariesStore.load()]);
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		initialLoading.value = false;
	}
}
watch([selectedId, programs], () => {
	if (scheduling.loaded && !scheduling.error && selectedId.value && !selected.value) {
		updateQuery({ selected: null }, true);
	}
});
onMounted(() => {
	media.addEventListener('change', updateViewport);
	window.addEventListener('resize', measureWorkspace);
	void load();
});
onUnmounted(() => {
	media.removeEventListener('change', updateViewport);
	window.removeEventListener('resize', measureWorkspace);
	resizeObserver?.disconnect();
});
</script>

<template>
	<section class="programs-page">
		<PageHeader v-if="!embedded" eyebrow="Reusable content rules" title="Programs" description="Programs define how eligible media is selected and arranged. Reuse them across multiple schedules and channels.">
			<RouterLink class="button programs-primary-button" :to="{ path: '/schedules/programs/new', query: route.query }"><Plus :size="18" />New Program</RouterLink>
		</PageHeader>
		<p v-if="!embedded && (error || scheduling.error)" class="notice error" role="alert">{{ error || scheduling.error }} <button type="button" class="button secondary" @click="load">Retry</button></p>
		<LoadingState v-if="!embedded && initialLoading" label="Loading programs…" />
		<div v-else-if="!embedded && scheduling.loaded" ref="workspace" class="program-management" :style="{ '--program-workspace-height': workspaceHeight }">
			<section class="program-management-catalog" aria-label="Programs catalog">
				<ProgramCatalogToolbar :filters="filters" @change="updateQuery" />
				<ProgramCatalogList v-if="filtered.length" ref="list" :programs="filtered" :all-programs="programById" :statuses="statuses" :usages="usages" :selected="selectedId" @select="selectProgram" @delete="deleteProgram" />
				<ResourceEmptyState v-else :title="programs.length ? 'No matching programs' : 'No programs yet'" :description="programs.length ? 'Adjust the search or filters to see more programs.' : 'Create a Program to define how media should be selected and arranged.'" :heading-level="3" :compact="programs.length > 0"><template #icon><ListOrdered :size="37" /></template><button v-if="programs.length" type="button" class="button" @click="updateQuery({ q: null, type: null, subtype: null, usage: null })">Clear Filters</button><RouterLink v-else class="button" :to="{ path: '/schedules/programs/new', query: route.query }">Create Your First Program</RouterLink></ResourceEmptyState>
			</section>
			<Teleport to="body" :disabled="!modal">
				<Transition name="program-inspection">
					<div v-if="selected && !editorOpen" :class="modal ? 'program-inspector-backdrop moirai-dialog-backdrop' : 'program-inspector-inline'" @click.self="modal && closeInspector()">
						<ProgramInspector :program="selected" :programs="programById" :status="statuses.get(selected.id)" :statuses="statuses" :libraries="librariesStore.libraries" :modal="modal" :action-error="error" :deleting="deleting" @close="closeInspector" @select="selectProgram" @delete="deleteProgram($event, true)" @refresh="refreshOverview" />
					</div>
				</Transition>
			</Teleport>
		</div>
		<ProgramEditor v-if="editorOpen && !initialLoading" :embedded="embedded" :program-id="programId" @close="emit('close')" @saved="id => emit('saved', id)" />
	</section>
</template>
