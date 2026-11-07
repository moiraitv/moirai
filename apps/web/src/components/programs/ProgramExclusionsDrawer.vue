<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { Asterisk, Ban, Check, Layers3, X } from '@lucide/vue';
import { MAX_EXCLUDED_MEDIA_ITEMS, MAX_EXPLICIT_MEDIA_GROUPS, type ContentExclusions, type MediaGroup, type MediaSelectionItem, type MediaSourcePickerTarget } from '@moirai/shared';
import { api } from '../../api';
import { artworkVariantUrl } from '../../artwork-url';
import { errorMessage } from '../../error-message';
import { hideBrokenImage } from '../../image-error';
import { mediaGroupSubtitle, mediaItemSubtitle } from '../../media-labels';
import LoadingState from '../LoadingState.vue';
import MediaCardPreview from '../MediaCardPreview.vue';
import TwoStepActionButton from '../TwoStepActionButton.vue';
import { subscribeToSelectedMediaRefresh } from './selected-media-refresh';

/** A library entry or a saved reference whose metadata is no longer indexed. */
interface ExclusionRow {
	id: string;
	kind: 'item' | 'group';
	item?: MediaSelectionItem;
	group?: MediaGroup;
	parentTitle?: string | undefined;
}

/** Bound metadata reads and the number of displayed controls on each tab. */
const PAGE_SIZE = 20;
/** Views shared by every source, with frozen results available for AI. */
type ExclusionTab = 'browse' | 'excluded' | 'results';
const props = defineProps<{ libraryId: string; libraryType: string; libraryName: string; resultIds?: string[] | undefined; initialTab: ExclusionTab }>();
const exclusions = defineModel<ContentExclusions>({ required: true });
const emit = defineEmits<{ close: []; removeMissing: [id: string] }>();
const id = useId();
const drawer = ref<HTMLElement>();
const panel = ref<HTMLElement>();
const visible = ref(true);
const tab = ref<ExclusionTab>(props.initialTab);
const hierarchy = ref<MediaGroup[]>([]);
const searchInput = ref('');
const search = ref('');
const target = ref<MediaSourcePickerTarget>(props.libraryType === 'shows' ? 'all' : 'items');
const browsePage = ref(1);
const excludedPage = ref(1);
const resultsPage = ref(1);
const resultSearch = ref('');
const resultRows = ref<ExclusionRow[]>([]);
const browsePages = ref(1);
const loadedTabs = ref(new Set<ExclusionTab>());
const rows = ref<ExclusionRow[]>([]);
const loading = ref(true);
const failure = ref('');
const actionError = ref('');
const aliases = ref<Record<string, string>>({});
let aliasRequest: Promise<Record<string, string>> | undefined;
let revision = 0;

const parent = computed(() => hierarchy.value.at(-1));
const itemReferencesByIdentity = computed(() => new Map(exclusions.value.itemIds.map(id => [canonicalItemId(id), id])));
const groupIds = computed(() => new Set(exclusions.value.groupIds));
const count = computed(() => itemReferencesByIdentity.value.size + groupIds.value.size);
const resultReferences = computed(() => new Set(props.resultIds));
const remainingResults = computed(() => resultRows.value.filter(row => row.item
	? !isExcluded(row) : resultReferences.value.has(row.id)));
const indexedResultIds = computed(() => remainingResults.value.filter(row => row.item).map(row => row.id));
const filteredResults = computed(() => {
	const query = resultSearch.value.trim().toLocaleLowerCase();
	return query ? remainingResults.value.filter(row => [title(row), row.item?.showSortTitle, row.item?.year].join(' ').toLocaleLowerCase().includes(query))
		: remainingResults.value;
});
const page = computed(() => tab.value === 'browse' ? browsePage.value : tab.value === 'excluded' ? excludedPage.value : resultsPage.value);
const totalPages = computed(() => tab.value === 'browse' ? browsePages.value
	: Math.max(1, Math.ceil((tab.value === 'excluded' ? count.value : filteredResults.value.length) / PAGE_SIZE)));
const displayedRows = computed(() => tab.value === 'results'
	? filteredResults.value.slice((resultsPage.value - 1) * PAGE_SIZE, resultsPage.value * PAGE_SIZE)
	: rows.value);
const tabs = computed<{ id: ExclusionTab; label: string }[]>(() => [
	...(props.resultIds ? [{ id: 'results' as const, label: 'Results' }] : []),
	{ id: 'browse', label: 'Browse library' },
	{ id: 'excluded', label: 'Excluded (' + count.value.toLocaleString() + ')' },
]);
const canSearchGroups = computed(() => props.libraryType === 'shows' || props.libraryType === 'music-videos');

/** Preview the indexed item while preserving the authored row ID for draft actions. */
function previewItem(item: MediaSelectionItem): MediaSelectionItem {
	return item.canonicalId ? { ...item, id: item.canonicalId } : item;
}

/** Resolve a saved item reference to the indexed identity shown by the library browser. */
function canonicalItemId(id: string): string {
	return aliases.value[id] ?? id;
}

/** Display the item's title or keep an identifiable entry for a missing saved reference. */
function title(row: ExclusionRow): string {
	return row.group?.title ?? row.item?.title ?? `Missing ${row.kind} · ${row.id}`;
}

/** Distinguish similarly named seasons, albums and episodes using their library context. */
function subtitle(row: ExclusionRow): string {
	if (row.group) {
		return [row.parentTitle, row.group.kind, mediaGroupSubtitle(props.libraryType, row.group)].filter(Boolean).join(' · ');
	}
	if (row.item) {
		return [row.parentTitle ?? row.item.showSortTitle, mediaItemSubtitle(props.libraryType, row.item) || row.item.kind].filter(Boolean).join(' · ');
	}
	return 'No longer indexed';
}

/** Identify explicit entries independently of any overlapping ancestor exclusion. */
function isExcluded(row: ExclusionRow): boolean {
	return row.kind === 'group' ? groupIds.value.has(row.id) : itemReferencesByIdentity.value.has(canonicalItemId(row.id));
}

/** Read only the current page of saved references, preserving missing identifiers in review. */
async function reviewPage(): Promise<ExclusionRow[]> {
	const start = (excludedPage.value - 1) * PAGE_SIZE;
	const groupReferences = exclusions.value.groupIds.slice(start, start + PAGE_SIZE);
	const groupCount = exclusions.value.groupIds.length;
	const itemReferences = [...itemReferencesByIdentity.value.values()].slice(Math.max(0, start - groupCount), Math.max(0, start + PAGE_SIZE - groupCount));
	const [groups, items] = await Promise.all([
		groupReferences.length ? api.mediaGroupSelection(props.libraryId, groupReferences) : [],
		itemReferences.length ? api.mediaSelection(props.libraryId, itemReferences) : [],
	]);
	const parentIds = [...new Set(groups.flatMap(group => group.parentId ? [group.parentId] : []))];
	const parents = parentIds.length ? await api.mediaGroupSelection(props.libraryId, parentIds) : [];
	const parentTitles = new Map(parents.map(group => [group.id, group.title]));
	const groupsById = new Map(groups.map(group => [group.id, group]));
	const itemsById = new Map(items.map(item => [item.id, item]));
	return [
		...groupReferences.map((id): ExclusionRow => {
			const group = groupsById.get(id);
			return { id, kind: 'group', ...(group ? { group, parentTitle: parentTitles.get(group.parentId ?? '') } : {}) };
		}),
		...itemReferences.map((id): ExclusionRow => {
			const item = itemsById.get(id);
			return { id, kind: 'item', ...(item ? { item } : {}) };
		}),
	];
}

/** Keep missing authored results in order and collapse aliases of indexed results. */
function reviewResults(ids: string[], items: MediaSelectionItem[]): ExclusionRow[] {
	const byId = new Map(items.map(item => [item.id, item]));
	const results = new Map<string, ExclusionRow>();
	for (const reference of ids) {
		const item = byId.get(reference);
		const id = item?.canonicalId ?? reference;
		if (!item?.excluded && !results.has(id)) {
			results.set(id, { id, kind: 'item', ...(item ? { item } : {}) });
		}
	}
	return [...results.values()];
}

/** Replace the visible page only when its library and navigation request are still current. */
async function load(): Promise<void> {
	const current = ++revision;
	loading.value = true;
	failure.value = '';
	try {
		aliasRequest ??= exclusions.value.itemIds.length ? api.mediaSelectionAliases(props.libraryId, exclusions.value.itemIds) : Promise.resolve({});
		const resolved = await aliasRequest;
		if (current !== revision) {
			return;
		}
		aliases.value = resolved;
		if (tab.value === 'results') {
			const ids = props.resultIds ?? [];
			const items = ids.length ? await api.mediaSelection(props.libraryId, ids, exclusions.value) : [];
			if (current === revision) {
				resultRows.value = reviewResults(ids, items);
				loadedTabs.value.add('results');
			}
			return;
		}
		if (tab.value === 'excluded') {
			if (excludedPage.value > totalPages.value) {
				excludedPage.value = totalPages.value;
				return;
			}
			const result = await reviewPage();
			if (current === revision) {
				rows.value = result;
				loadedTabs.value.add('excluded');
			}
			return;
		}

		const result = await api.mediaSourceOptions(props.libraryId, {
			parentId: parent.value?.id, target: search.value ? target.value : 'items', search: search.value,
			groupMatch: props.libraryType === 'shows' && target.value === 'groups' ? 'direct' : undefined,
			page: browsePage.value, pageSize: PAGE_SIZE,
		});
		if (current === revision) {
			browsePages.value = result.pagination.totalPages;
			if (browsePage.value > browsePages.value) {
				browsePage.value = browsePages.value;
				return;
			}
			rows.value = result.entries.map(entry => ({ id: entry.key, kind: entry.kind,
				...(entry.group ? { group: entry.group } : {}), ...(entry.item ? { item: entry.item } : {}),
				parentTitle: entry.parentTitle ?? parent.value?.title }));
			loadedTabs.value.add('browse');
		}
	}
	catch (cause) {
		if (current === revision) {
			aliasRequest = undefined;
			failure.value = errorMessage(cause);
		}
	}
	finally {
		if (current === revision) {
			loading.value = false;
		}
	}
}

/** Navigate into a group or back to an earlier level, starting with unfiltered rows. */
function browse(path: MediaGroup[]): void {
	hierarchy.value = path;
	searchInput.value = '';
	search.value = '';
	browsePage.value = 1;
	panel.value?.focus({ preventScroll: true });
}

/** Search the current level and reset the search result page. */
function submitSearch(): void {
	search.value = searchInput.value.trim();
	browsePage.value = 1;
}

/** Move to a different page without mixing the review and browse positions. */
function movePage(offset: number): void {
	if (loading.value || failure.value || page.value + offset < 1 || page.value + offset > totalPages.value) {
		return;
	}

	if (tab.value === 'browse') {
		browsePage.value += offset;
	}
	else if (tab.value === 'excluded') {
		excludedPage.value += offset;
	}
	else {
		resultsPage.value += offset;
	}
	panel.value?.scrollTo({ top: 0, behavior: 'instant' });
	panel.value?.focus({ preventScroll: true });
}

/** Apply the shared tab navigation keys to the adjacent browse and review controls. */
async function navigateTabs(event: KeyboardEvent): Promise<void> {
	const index = tabs.value.findIndex(entry => entry.id === tab.value);
	let next = index;
	if (event.key === 'Home') {
		next = 0;
	}
	else if (event.key === 'End') {
		next = tabs.value.length - 1;
	}
	else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
		next = (index + tabs.value.length + (event.key === 'ArrowLeft' ? -1 : 1)) % tabs.value.length;
	}
	else {
		return;
	}

	event.preventDefault();
	tab.value = tabs.value[next]!.id;
	await nextTick();
	document.getElementById(`${id}-${tab.value}`)?.focus();
}

/** Add one explicit exclusion while leaving descendant and ancestor entries independently editable. */
function exclude(row: ExclusionRow): void {
	if (isExcluded(row)) {
		return;
	}
	const field = row.kind === 'group' ? 'groupIds' : 'itemIds';
	const limit = row.kind === 'group' ? MAX_EXPLICIT_MEDIA_GROUPS : MAX_EXCLUDED_MEDIA_ITEMS;
	if (exclusions.value[field].length >= limit) {
		actionError.value = `You can exclude up to ${limit.toLocaleString()} ${row.kind}s.`;
		return;
	}
	actionError.value = '';
	exclusions.value = { ...exclusions.value, [field]: [...exclusions.value[field], row.id].sort() };
	panel.value?.focus({ preventScroll: true });
}

/** Remove one deleted result from the frozen draft without changing the remaining order. */
function removeMissingResult(id: string): void {
	emit('removeMissing', id);
	actionError.value = '';
	panel.value?.focus({ preventScroll: true });
}

/** Exclude indexed results while leaving missing references available for explicit removal. */
function excludeAllResults(): void {
	const ids = new Set([...exclusions.value.itemIds, ...indexedResultIds.value]);
	if (ids.size > MAX_EXCLUDED_MEDIA_ITEMS) {
		actionError.value = 'The results exceed the maximum number of item exclusions.';
		return;
	}
	actionError.value = '';
	exclusions.value = { ...exclusions.value, itemIds: [...ids].sort() };
	panel.value?.focus({ preventScroll: true });
}

/** Remove a confirmed exclusion and keep review focused on a valid page. */
function restore(row: ExclusionRow): void {
	const field = row.kind === 'group' ? 'groupIds' : 'itemIds';
	excludedPage.value = Math.min(excludedPage.value, Math.max(1, Math.ceil((count.value - 1) / PAGE_SIZE)));
	actionError.value = '';
	const identity = row.kind === 'item' ? canonicalItemId(row.id) : row.id;
	const remaining = exclusions.value[field].filter(value => (row.kind === 'item' ? canonicalItemId(value) : value) !== identity);
	exclusions.value = { ...exclusions.value, [field]: remaining };
	panel.value?.focus({ preventScroll: true });
}

/** Keep the drawer mounted until the shared exit transition completes. */
function close(): void {
	visible.value = false;
}

watch([() => parent.value?.id, search, () => search.value ? target.value : null], () => {
	browsePages.value = 1;
});
watch(() => {
	if (tab.value === 'browse') {
		return [tab.value, parent.value?.id, browsePage.value, search.value, search.value ? target.value : null];
	}
	if (tab.value === 'excluded') {
		return [tab.value, excludedPage.value, exclusions.value];
	}
	return tab.value;
}, () => void load(), { immediate: true });
watch([tab, totalPages], ([currentTab, pages]) => {
	if (currentTab === 'results' && resultsPage.value > pages) {
		resultsPage.value = pages;
	}
});
const unsubscribe = subscribeToSelectedMediaRefresh(() => props.libraryId, () => visible.value, () => {
	aliasRequest = undefined;
	void load();
});
onMounted(() => drawer.value?.focus());
onBeforeUnmount(() => {
	unsubscribe();
	revision += 1;
});
</script>

<template>
	<Teleport to="body">
		<Transition name="selection-drawer" appear @after-leave="emit('close')">
			<div v-show="visible" class="selection-drawer-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="close">
				<aside ref="drawer" v-modal-focus="{ escape: close }" class="selection-drawer program-matches-drawer program-exclusions-drawer" role="dialog" aria-modal="true" :aria-labelledby="`${id}-title`" tabindex="-1">
					<header class="selection-drawer-header">
						<div>
							<h2 :id="`${id}-title`">Manage exclusions</h2>
							<p>Exclude items or groups from this Program. Save the Program to apply your changes.</p>
						</div>
						<button type="button" aria-label="Close exclusions" @click="close"><X :size="21" aria-hidden="true" /></button>
					</header>
					<div class="program-matches-toolbar">
						<div class="program-matches-tabs" role="tablist" aria-label="Exclusions">
							<button v-for="entry in tabs" :id="id + '-' + entry.id" :key="entry.id" type="button" role="tab" :aria-selected="tab === entry.id" :aria-controls="id + '-panel'" :tabindex="tab === entry.id ? 0 : -1" @click="tab = entry.id" @keydown="navigateTabs">{{ entry.label }}</button>
						</div>
					</div>
					<div :id="`${id}-panel`" ref="panel" class="selection-drawer-content" role="tabpanel" :aria-labelledby="`${id}-${tab}`" tabindex="0">
						<template v-if="tab === 'browse'">
							<form class="program-exclusions-search" role="search" @submit.prevent="submitSearch">
								<input v-model="searchInput" type="search" aria-label="Search library media" placeholder="Search library…" maxlength="120" @search="!searchInput && submitSearch()" />
								<select v-if="canSearchGroups" v-model="target" aria-label="Search for" @change="submitSearch">
									<option v-if="libraryType === 'shows'" value="all">All</option>
									<option value="items">Items</option>
									<option value="groups">Groups</option>
								</select>
								<button type="submit" class="toolbar-button">Search</button>
							</form>
							<nav v-if="parent" class="program-exclusions-path" aria-label="Library location">
								<button type="button" class="text-button" @click="browse([])">{{ libraryName }}</button>
								<template v-for="(group, index) in hierarchy" :key="group.id">
									<span aria-hidden="true">›</span>
									<span v-if="group.id === parent.id" aria-current="location">{{ group.title }}</span>
									<button v-else type="button" class="text-button" @click="browse(hierarchy.slice(0, index + 1))">{{ group.title }}</button>
								</template>
							</nav>
						</template>
						<template v-else-if="tab === 'results'">
							<input v-model="resultSearch" type="search" aria-label="Search AI results" placeholder="Search results…" @input="resultsPage = 1" />
							<small v-if="!loading && !failure" role="status">{{ filteredResults.length.toLocaleString() }} {{ filteredResults.length === 1 ? 'matching result' : 'matching results' }}</small>
						</template>
						<p v-else class="muted">Group exclusions cover all descendants. Restoring an entry still leaves it excluded if an ancestor is excluded.</p>
						<p v-if="actionError" class="notice warning" role="alert">{{ actionError }}</p>
						<div :aria-busy="loading">
							<LoadingState v-if="loading" :label="tab === 'browse' ? 'Loading library media…' : 'Loading exclusions…'" />
							<p v-else-if="failure" class="notice warning" role="alert">{{ failure }} <button type="button" class="text-button" @click="load">Try again</button></p>
							<div v-else-if="displayedRows.length" class="source-picker-list program-exclusions-list">
								<component
									:is="row.item ? MediaCardPreview : 'div'"
									v-for="row in displayedRows"
									:key="`${row.kind}-${row.id}-${row.item?.canonicalId ?? ''}`"
									v-bind="row.item ? { item: previewItem(row.item) } : {}"
									class="program-exclusions-row"
								>
									<article :tabindex="row.item && tab === 'browse' && isExcluded(row) ? 0 : undefined">
										<span class="source-picker-artwork" aria-hidden="true">
											<span class="source-artwork-placeholder"><Layers3 v-if="row.kind === 'group'" :size="18" /><Asterisk v-else :size="18" /></span>
											<img v-if="row.group?.artworkUrl || row.item?.artworkUrl" :src="artworkVariantUrl(row.group?.artworkUrl ?? row.item?.artworkUrl, 'thumb')" alt="" loading="lazy" decoding="async" @error="hideBrokenImage" />
										</span>
										<span class="source-picker-copy"><strong>{{ title(row) }}</strong><small :id="`${id}-${row.kind}-${row.id}`">{{ subtitle(row) }}</small></span>
										<div class="source-picker-actions">
											<button v-if="tab === 'browse' && row.group && row.group.childCount > 0" type="button" class="button secondary contextual" :aria-label="`Browse ${title(row)}`" :aria-describedby="`${id}-${row.kind}-${row.id}`" @click="browse([...hierarchy, row.group])">Browse</button>
											<TwoStepActionButton v-if="tab === 'results' && !row.item" class="toolbar-button" :label="`Remove ${title(row)}`" :confirm-label="`Confirm remove ${title(row)}`" :aria-describedby="`${id}-${row.kind}-${row.id}`" tone="caution" @confirm="removeMissingResult(row.id)">Remove</TwoStepActionButton>
											<TwoStepActionButton
												v-else-if="tab !== 'excluded'" class="toolbar-button" :class="{ 'exclusion-selected': isExcluded(row) }"
												:disabled="isExcluded(row)" :label="`${isExcluded(row) ? 'Excluded' : 'Exclude'} ${title(row)}`"
												:confirm-label="`Confirm exclude ${title(row)}`" :aria-describedby="`${id}-${row.kind}-${row.id}`" @confirm="exclude(row)"
											><Check v-if="isExcluded(row)" :size="16" aria-hidden="true" /><Ban v-else :size="16" aria-hidden="true" />{{ isExcluded(row) ? 'Excluded' : 'Exclude' }}</TwoStepActionButton>
											<TwoStepActionButton v-else class="toolbar-button" :label="`Restore ${title(row)}`" :confirm-label="`Confirm restore ${title(row)}`" :aria-describedby="`${id}-${row.kind}-${row.id}`" tone="caution" @confirm="restore(row)">Restore</TwoStepActionButton>
										</div>
									</article>
								</component>
							</div>
							<p v-else class="empty-state compact">{{ tab === 'browse' ? 'No matching library media.' : tab === 'results' ? 'No matching AI results.' : 'No exclusions added.' }}</p>
						</div>
					</div>
					<footer class="selection-drawer-footer program-exclusions-footer">
						<nav v-if="loadedTabs.has(tab) && totalPages > 1" class="source-picker-pagination" aria-label="Exclusions pagination">
							<button type="button" class="toolbar-button" :disabled="loading || Boolean(failure) || page <= 1" @click="movePage(-1)">Previous</button>
							<small>Page {{ Math.min(page, totalPages) }} of {{ totalPages }}</small>
							<button type="button" class="toolbar-button" :disabled="loading || Boolean(failure) || page >= totalPages" @click="movePage(1)">Next</button>
						</nav>
						<div class="program-exclusions-actions">
							<TwoStepActionButton v-if="tab === 'results'" class="toolbar-button danger-button" :disabled="loading || Boolean(failure) || !indexedResultIds.length" label="Exclude all results" confirm-label="Confirm exclude all results" confirm-text="Confirm exclude" @confirm="excludeAllResults">
								<Ban :size="16" aria-hidden="true" />Exclude all results
							</TwoStepActionButton>
							<button type="button" class="button secondary" @click="close">Done</button>
						</div>
					</footer>
				</aside>
			</div>
		</Transition>
	</Teleport>
</template>
