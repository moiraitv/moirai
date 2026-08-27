<script setup lang="ts">
import {
	computed,
	nextTick,
	onBeforeUpdate,
	onMounted,
	onUnmounted,
	reactive,
	ref,
	watch,
	type ComponentPublicInstance,
} from 'vue';
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router';
import { artworkSrcset, artworkVariantUrl } from '../artwork-url';
import { errorMessage } from '../error-message';
import { hideBrokenImage } from '../image-error';
import {
	ArrowDownAZ,
	ArrowUpAZ,
	AlertTriangle,
	Asterisk,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	CircleCheck,
	CircleHelp,
	Clock3,
	Filter,
	Layers3,
	MoreHorizontal,
	RefreshCw,
	Search,
	Trash2,
	Unplug,
	Zap,
} from '@lucide/vue';
import type {
	GenreMatch,
	Library,
	MediaBrowseResult,
	MediaGenreFacet,
	MediaGroup,
	MediaSort,
	ScanProgress,
	ScanRun,
	LibraryReconciliation,
	ReconciliationAction,
} from '@moirai/shared';
import { api, type MediaQuery } from '../api';
import { activeCatalogAnchor, breadcrumbTargetTrail } from '../catalog-navigation';
import LoadingState from '../components/LoadingState.vue';
import LibraryFilterModal from '../components/library/LibraryFilterModal.vue';
import LibraryReconciliationModal from '../components/library/LibraryReconciliationModal.vue';
import StatusPill from '../components/StatusPill.vue';
import { liveEvents } from '../live-events';
import { isLibrarySourceUnavailable } from '../library-health';
import { mediaGroupSubtitle, mediaItemSubtitle } from '../media-labels';
import { useLibrariesStore } from '../stores/libraries';

const route = useRoute();
const router = useRouter();
const librariesStore = useLibrariesStore();
const id = computed(() => String(route.params.id));
const library = ref<Library>();
const scans = ref<ScanRun[]>([]);
const reconciliation = ref<LibraryReconciliation>();
const genres = ref<MediaGenreFacet[]>([]);
const browse = ref<MediaBrowseResult>();
const latestScan = computed(() => scans.value[0]);
const activeScanId = ref<string>();
const activeScanProgress = ref<ScanProgress>();
const sourceUnavailable = computed(() =>
	library.value ? isLibrarySourceUnavailable(library.value) : false);
const scanProgressPercent = computed(() => {
	const progress = activeScanProgress.value;
	if (!progress || progress.totalCount === null) {
		return null;
	}

	if (progress.totalCount === 0) {
		return progress.phase === 'finalizing' ? 100 : 0;
	}

	return Math.min(100, Math.floor(progress.processedCount / progress.totalCount * 100));
});
const scanProgressDescription = computed(() => {
	const progress = activeScanProgress.value;
	if (!progress || progress.phase === 'discovering') {
		return 'Discovering media files';
	}

	if (progress.phase === 'finalizing') {
		return 'Finalizing scan';
	}

	return `${scanProgressPercent.value ?? 0}% · ${progress.processedCount.toLocaleString()} of ${progress.totalCount?.toLocaleString() ?? 0}`;
});
const searchInput = ref<HTMLInputElement>();
const libraryPage = ref<HTMLElement>();
const libraryHeader = ref<HTMLElement>();
const catalogToolbar = ref<HTMLElement>();
const catalogResults = ref<HTMLElement>();
const navigationScroller = ref<HTMLElement>();
const searchText = ref(queryString('q'));
const message = ref('');
const initialLoading = ref(true);
const mediaLoading = ref(false);
const loadError = ref('');
const showMenu = ref(false);
const showSort = ref(false);
const showFilter = ref(false);
const showReconciliation = ref(false);
const reconciliationBusy = ref(false);
const alphabet = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const anchorElements = new Map<string, HTMLElement>();
const navigationButtons = new Map<string, HTMLElement>();
const activeScrollAnchor = ref('');
/** Breadcrumb entry stored in route state for hierarchical catalog browsing. */
type CatalogScrollBehavior = 'auto' | 'smooth';

/** Scan-history row with its issue summary decoded for display. */
interface FilterDraft {
	name: string;
	releaseFrom: string;
	releaseTo: string;
	addedFrom: string;
	addedTo: string;
	genres: string[];
	genreMatch: GenreMatch;
	actor: string;
	director: string;
}

const filterDraft = reactive<FilterDraft>({
	name: '',
	releaseFrom: '',
	releaseTo: '',
	addedFrom: '',
	addedTo: '',
	genres: [],
	genreMatch: 'any',
	actor: '',
	director: '',
});

/** Read one string value from the current route query. */
function queryString(key: string): string {
	const value = route.query[key];
	return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

/** Read a route query value as a normalized list of strings. */
function queryStrings(key: string): string[] {
	const value = route.query[key];
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === 'string');
	}

	return typeof value === 'string' && value ? [value] : [];
}

const sort = computed<MediaSort>(() => {
	const value = queryString('sort');
	return value === 'date-added' || value === 'genre' ? value : 'title';
});
const direction = computed<'asc' | 'desc'>(() =>
	queryString('direction') === 'desc' ? 'desc' : 'asc');
const page = computed(() => Math.max(1, Number(queryString('page')) || 1));
const parentId = computed(() => queryString('parent') || undefined);
const dateWindow = computed(() => queryString('dateWindow'));
const routeAnchor = computed(() => queryString('anchor'));
const entries = computed(() => browse.value?.entries ?? []);
const pagination = computed(() => browse.value?.pagination);
const trail = computed<Array<{ id?: string; title: string }>>(() => {
	try {
		const parsed = JSON.parse(queryString('trail') || '[]') as Array<{ id: string; title: string }>;
		return [{ title: 'All media' }, ...parsed];
	}
	catch {
		return [{ title: 'All media' }];
	}
});

const typeLabel = computed(() => {
	switch (library.value?.typeKey) {
		case 'movies':
			return 'Movies';
		case 'shows':
			return 'TV shows';
		case 'music-videos':
			return 'Music videos';
		default:
			return 'Media';
	}
});

const sortLabel = computed(() => {
	const label
		= sort.value === 'date-added' ? 'Date Added' : sort.value === 'genre' ? 'Genre' : 'Title';
	const suffix = direction.value === 'asc' ? 'A–Z' : 'Z–A';
	return sort.value === 'date-added'
		? `Sort by: ${label} ${direction.value === 'asc' ? 'Oldest' : 'Newest'}`
		: `Sort by: ${label} ${suffix}`;
});

const activeFilterCount = computed(
	() =>
		[
			queryString('q'),
			queryString('releaseFrom') || queryString('releaseTo'),
			queryString('addedFrom') || queryString('addedTo') || dateWindow.value,
			queryStrings('genre').length ? 'genre' : '',
			queryString('actor'),
			queryString('director'),
		].filter(Boolean).length,
);

const activeNavigationKey = computed(() => {
	if (sort.value === 'date-added') {
		return dateWindow.value;
	}

	if (activeScrollAnchor.value) {
		return activeScrollAnchor.value;
	}

	const keys = new Set(entries.value.map((entry) => entry.navigationKey));
	if (routeAnchor.value && keys.has(routeAnchor.value)) {
		return routeAnchor.value;
	}

	if (sort.value === 'title') {
		return alphabet.find((key) => keys.has(key)) ?? '';
	}

	return browse.value?.navigation.find((option) => keys.has(option.key))?.key ?? '';
});

const anchorKeys = computed(() => [
	...new Set(entries.value.map((entry) => entry.navigationKey).filter(Boolean)),
]);

const pageButtons = computed(() => {
	const total = pagination.value?.totalPages ?? 1;
	const current = page.value;
	return [...new Set([1, current - 1, current, current + 1, total])]
		.filter((value) => value >= 1 && value <= total)
		.sort((left, right) => left - right);
});

/** Return whether the latest scan has started but not completed. */
function isScanRunning(): boolean {
	return Boolean(
		library.value?.lastScanStartedAt
		&& (!library.value.lastScanCompletedAt
			|| library.value.lastScanStartedAt > library.value.lastScanCompletedAt),
	);
}

/** Format an optional activity timestamp in the viewer's locale. */
function formatDate(value: string | null | undefined): string {
	return value
		? new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		}).format(new Date(value))
		: 'Not yet';
}

/** Summarize elapsed time since an optional activity timestamp. */
function formatRelative(value: string | null | undefined): string {
	if (!value) {
		return 'No activity recorded';
	}

	const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
	if (elapsedSeconds < 60) {
		return elapsedSeconds < 5 ? 'Just now' : `${elapsedSeconds}s ago`;
	}

	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) {
		return `${elapsedMinutes}m ago`;
	}

	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) {
		return `${elapsedHours}h ago`;
	}

	return `${Math.floor(elapsedHours / 24)}d ago`;
}

/** Return local midnight for a date-like input. */
function localDay(value: string, end = false): string | undefined {
	if (!value) {
		return undefined;
	}

	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(year!, month! - 1, day! + (end ? 1 : 0));
	return date.toISOString();
}

/** Resolve a named added-date window into inclusive route filters. */
function dateWindowBounds(key: string): Pick<MediaQuery, 'addedFrom' | 'addedBefore'> {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	if (key === 'today') {
		return { addedFrom: today.toISOString() };
	}

	if (key === 'week') {
		const start = new Date(today);
		start.setDate(start.getDate() - start.getDay());
		return { addedFrom: start.toISOString() };
	}

	if (key === 'month') {
		return { addedFrom: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
	}

	const sixMonths = new Date(today);
	sixMonths.setMonth(sixMonths.getMonth() - 6);
	if (key === 'older') {
		return { addedBefore: sixMonths.toISOString() };
	}

	const start = new Date(today);
	start.setMonth(start.getMonth() - (key === 'three-months' ? 3 : 6));
	return { addedFrom: start.toISOString() };
}

/** Build the catalog API query represented by current route state. */
function currentMediaQuery(): MediaQuery {
	const releaseFrom = Number(queryString('releaseFrom'));
	const releaseTo = Number(queryString('releaseTo'));
	const windowBounds = dateWindow.value ? dateWindowBounds(dateWindow.value) : {};
	return {
		parentId: parentId.value,
		page: page.value,
		pageSize: 48,
		sort: sort.value,
		direction: direction.value,
		name: queryString('q') || undefined,
		releaseYearFrom: releaseFrom || undefined,
		releaseYearTo: releaseTo || undefined,
		addedFrom: windowBounds.addedFrom ?? localDay(queryString('addedFrom')),
		addedBefore: windowBounds.addedBefore ?? localDay(queryString('addedTo'), true),
		genres: queryStrings('genre'),
		genreMatch: queryString('genreMatch') === 'all' ? 'all' : 'any',
		actor: queryString('actor') || undefined,
		director: queryString('director') || undefined,
	};
}

/** Create a stable signature for route-driven catalog state. */
function mediaStateSignature(): string {
	return JSON.stringify(
		Object.entries(route.query)
			.filter(([key]) => key !== 'anchor')
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

/** Return whether an entry starts a new navigation section on the current page. */
function isAnchorStart(index: number): boolean {
	const key = entries.value[index]?.navigationKey;
	return Boolean(
		sort.value !== 'date-added' && key && key !== entries.value[index - 1]?.navigationKey,
	);
}

/** Retain the rendered element that begins a catalog navigation section. */
function setAnchorElement(key: string, element: Element | ComponentPublicInstance | null): void {
	const resolved
		= element instanceof HTMLElement
			? element
			: element && '$el' in element
				? (element.$el as unknown)
				: null;
	if (resolved instanceof HTMLElement) {
		anchorElements.set(key, resolved);
	}
}

/** Register an entry as a section anchor when it starts an unlabeled section. */
function setEntryAnchor(
	index: number,
	key: string,
	element: Element | ComponentPublicInstance | null,
): void {
	if (isAnchorStart(index) && !entries.value[index]?.sectionLabel) {
		setAnchorElement(key, element);
	}
}

/** Retain a rendered navigation button so the active choice can be revealed. */
function setNavigationButton(key: string, element: Element | ComponentPublicInstance | null): void {
	const resolved
		= element instanceof HTMLElement
			? element
			: element && '$el' in element
				? (element.$el as unknown)
				: null;
	if (resolved instanceof HTMLElement) {
		navigationButtons.set(key, resolved);
	}
}

/** Return the vertical boundary used to select the active catalog anchor. */
function stickyBoundary(): number {
	if (!libraryPage.value || !libraryHeader.value || !catalogToolbar.value) {
		return 0;
	}

	const applicationOffset = Number.parseFloat(
		getComputedStyle(libraryPage.value).getPropertyValue('--app-header-offset'),
	);
	return (
		(Number.isFinite(applicationOffset) ? applicationOffset : 0)
		+ libraryHeader.value.offsetHeight
		+ catalogToolbar.value.offsetHeight
	);
}

/** Publish measured sticky-header heights for layout and scroll calculations. */
function updateStickyMetrics(): void {
	if (!libraryPage.value || !libraryHeader.value || !catalogToolbar.value) {
		return;
	}

	libraryPage.value.style.setProperty(
		'--library-header-height',
		`${libraryHeader.value.offsetHeight}px`,
	);
	libraryPage.value.style.setProperty(
		'--catalog-toolbar-height',
		`${catalogToolbar.value.offsetHeight}px`,
	);
	scheduleAnchorUpdate();
}

/** Scroll the active sub-navigation button into view. */
function revealNavigationButton(key: string, behavior: CatalogScrollBehavior): void {
	const scroller = navigationScroller.value;
	const button = navigationButtons.get(key);
	if (!scroller || !button) {
		return;
	}

	const scrollerBounds = scroller.getBoundingClientRect();
	const buttonBounds = button.getBoundingClientRect();
	if (buttonBounds.left < scrollerBounds.left) {
		scroller.scrollBy({ left: buttonBounds.left - scrollerBounds.left - 10, behavior });
	}
	else if (buttonBounds.right > scrollerBounds.right) {
		scroller.scrollBy({ left: buttonBounds.right - scrollerBounds.right + 10, behavior });
	}
}

let ignoreNextAnchorRouteChange = false;
let programmaticScroll = false;
let programmaticScrollTimer: number | undefined;
let pendingAnchorBehavior: CatalogScrollBehavior | null = null;

/** Update the route anchor without adding browser history. */
function replaceObservedAnchor(key: string): void {
	if (!key || routeAnchor.value === key) {
		return;
	}

	const query: LocationQueryRaw = { ...route.query, anchor: key };
	ignoreNextAnchorRouteChange = true;
	void router.replace({ path: route.path, query }).catch(() => {
		ignoreNextAnchorRouteChange = false;
	});
}

/** End a controlled scroll and resume scroll-position anchor tracking. */
function finishProgrammaticScroll(): void {
	window.clearTimeout(programmaticScrollTimer);
	programmaticScroll = false;
	scheduleAnchorUpdate();
}

/** Scroll a catalog section below the sticky controls and keep its navigation state active. */
async function scrollToAnchor(
	key: string,
	requestedBehavior: CatalogScrollBehavior,
): Promise<boolean> {
	await nextTick();
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	const target = anchorElements.get(key);
	if (!target) {
		return false;
	}

	const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
		? 'auto'
		: requestedBehavior;
	activeScrollAnchor.value = key;
	revealNavigationButton(key, behavior);
	programmaticScroll = true;
	window.clearTimeout(programmaticScrollTimer);
	window.scrollTo({
		top: Math.max(0, window.scrollY + target.getBoundingClientRect().top - stickyBoundary() - 4),
		behavior,
	});
	programmaticScrollTimer = window.setTimeout(
		finishProgrammaticScroll,
		behavior === 'smooth' ? 700 : 0,
	);
	return true;
}

/** Scroll the catalog results to the first unobscured position below the sticky controls. */
async function scrollToCatalogStart(): Promise<void> {
	await nextTick();
	const target = catalogResults.value;
	if (!target) {
		return;
	}

	window.scrollTo({
		top: Math.max(0, window.scrollY + target.getBoundingClientRect().top - stickyBoundary() - 4),
		behavior: 'auto',
	});
}

/** Derive the active catalog section from scroll position and reflect it in route state. */
function updateActiveAnchor(): void {
	if (programmaticScroll || sort.value === 'date-added') {
		return;
	}

	const positions = anchorKeys.value.flatMap((key) => {
		const element = anchorElements.get(key);
		return element ? [{ key, top: element.getBoundingClientRect().top }] : [];
	});
	const atDocumentEnd
		= window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
	const key = activeCatalogAnchor(positions, stickyBoundary() + 4, atDocumentEnd);
	if (!key) {
		return;
	}

	if (activeScrollAnchor.value !== key) {
		activeScrollAnchor.value = key;
		revealNavigationButton(key, 'auto');
	}
	replaceObservedAnchor(key);
}

let anchorUpdateFrame: number | undefined;
/** Coalesce scroll-driven anchor calculations into one animation frame. */
function scheduleAnchorUpdate(): void {
	if (anchorUpdateFrame !== undefined) {
		return;
	}

	anchorUpdateFrame = requestAnimationFrame(() => {
		anchorUpdateFrame = undefined;
		updateActiveAnchor();
	});
}

let resizeObserver: ResizeObserver | undefined;
/** Watch sticky header sizes and refresh catalog scroll geometry. */
function observeStickyElements(): void {
	resizeObserver?.disconnect();
	if (!libraryHeader.value || !catalogToolbar.value) {
		return;
	}

	resizeObserver = new ResizeObserver(updateStickyMetrics);
	resizeObserver.observe(libraryHeader.value);
	resizeObserver.observe(catalogToolbar.value);
	updateStickyMetrics();
}

/** Restore the requested catalog anchor or settle on the first available section. */
async function settleCatalogPosition(
	behavior: CatalogScrollBehavior,
	moveToStart: boolean,
): Promise<void> {
	const anchor = routeAnchor.value;
	if (anchor && anchorKeys.value.includes(anchor)) {
		await scrollToAnchor(anchor, behavior);
		return;
	}

	activeScrollAnchor.value = anchorKeys.value[0] ?? '';
	if (anchor && activeScrollAnchor.value) {
		replaceObservedAnchor(activeScrollAnchor.value);
	}
	if (moveToStart) {
		await scrollToCatalogStart();
	}
	revealNavigationButton(activeNavigationKey.value, 'auto');
	scheduleAnchorUpdate();
}

/** Update library route state so navigation remains compatible with browser history. */
async function navigate(
	updates: Record<string, string | string[] | number | undefined>,
): Promise<void> {
	const query: LocationQueryRaw = { ...route.query };
	if (!Object.hasOwn(updates, 'anchor')) {
		delete query.anchor;
	}
	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
			delete query[key];
		}
		else {
			query[key] = value;
		}
	}
	await router.push({ path: route.path, query });
}

/** Refresh library health, scan history, genre facets, and reconciliation state together. */
async function loadLibrary(): Promise<void> {
	[library.value, scans.value, genres.value, reconciliation.value] = await Promise.all([
		api.library(id.value),
		api.scans(id.value),
		api.mediaGenres(id.value),
		api.libraryReconciliation(id.value),
	]);
	const runningScan = scans.value.find((entry) => entry.status === 'running');
	if (!runningScan) {
		activeScanId.value = undefined;
		activeScanProgress.value = undefined;
	}
	else if (activeScanId.value !== runningScan.id) {
		activeScanId.value = runningScan.id;
		activeScanProgress.value = undefined;
	}
}

/** Load the catalog page represented by the current route filters and navigation state. */
async function loadMedia(): Promise<void> {
	mediaLoading.value = true;
	try {
		browse.value = await api.media(id.value, currentMediaQuery());
	}
	finally {
		mediaLoading.value = false;
	}
}

/** Load initial library data, then restore sticky geometry and the routed catalog position. */
async function loadInitial(): Promise<void> {
	initialLoading.value = true;
	loadError.value = '';
	try {
		await Promise.all([loadLibrary(), loadMedia()]);
	}
	catch (cause) {
		loadError.value = errorMessage(cause);
	}
	finally {
		initialLoading.value = false;
	}
	await nextTick();
	observeStickyElements();
	await settleCatalogPosition('auto', false);
}

/** Request a library scan and surface its current status. */
async function scan(): Promise<void> {
	showMenu.value = false;
	await api.scanLibrary(id.value);
	message.value = 'Scan queued';
	window.setTimeout(() => void loadLibrary(), 1200);
}

/** Ask the active scanner to stop without discarding the existing index. */
async function cancelScan(): Promise<void> {
	await api.cancelLibraryScan(id.value);
	message.value = 'Scan cancellation requested';
	window.setTimeout(() => void loadLibrary(), 300);
}

/** Apply the selected source or removal reconciliation action. */
async function reconcile(action: ReconciliationAction['action']): Promise<void> {
	const current = reconciliation.value;
	if (!current?.revision) {
		return;
	}

	if (
		action === 'confirm-removals'
		&& !confirm(`Permanently remove ${current.pendingRemovalCount} missing item(s) from the index?`)
	) {
		return;
	}

	if (
		action === 'accept-source'
		&& !confirm(
			'Replace this library index with the reviewed source? Media files will not be changed.',
		)
	) {
		return;
	}

	reconciliationBusy.value = true;
	try {
		await api.reconcileLibrary(id.value, { action, revision: current.revision });
		message.value
			= action === 'accept-source'
				? 'Source acceptance scan queued'
				: action === 'cancel-source-change'
					? 'Source change cancelled; rescan queued'
					: 'Missing items removed from the index';
		showReconciliation.value = false;
		await loadLibrary();
		if (action === 'confirm-removals') {
			await loadMedia();
		}
	}
	catch (cause) {
		loadError.value = errorMessage(cause);
	}
	finally {
		reconciliationBusy.value = false;
	}
}

/** Change catalog ordering, restore its default direction, and return to the first page. */
async function selectSort(value: MediaSort): Promise<void> {
	showSort.value = false;
	await navigate({
		sort: value === 'title' ? undefined : value,
		direction: value === 'date-added' ? 'desc' : 'asc',
		page: undefined,
		dateWindow: undefined,
	});
}

/** Reverse the current catalog ordering and return to the first page. */
async function toggleDirection(): Promise<void> {
	await navigate({ direction: direction.value === 'asc' ? 'desc' : 'asc', page: undefined });
}

/** Navigate to the first page containing a section and scroll to its local anchor. */
async function navigateToKey(key: string): Promise<void> {
	const option = browse.value?.navigation.find((entry) => entry.key === key);
	if (option) {
		if (option.firstPage === page.value && routeAnchor.value === key) {
			await scrollToAnchor(key, 'smooth');
			return;
		}

		pendingAnchorBehavior = 'smooth';
		await navigate({
			page: option.firstPage === 1 ? undefined : option.firstPage,
			anchor: key,
		});
	}
}

/** Apply a relative added-date window and clear conflicting explicit date filters. */
async function selectDateWindow(key: string): Promise<void> {
	await navigate({ dateWindow: key, addedFrom: undefined, addedTo: undefined, page: undefined });
}

/** Open a media group and record it in the breadcrumb trail. */
async function enter(group: MediaGroup): Promise<void> {
	const nextTrail = [...trail.value.slice(1), { id: group.id, title: group.title }];
	await navigate({ parent: group.id, trail: JSON.stringify(nextTrail), page: undefined });
}

/** Navigate to the selected breadcrumb level. */
async function jump(index: number): Promise<void> {
	const nextTrail = breadcrumbTargetTrail(trail.value, index);
	const parent = nextTrail.at(-1)?.id;
	await navigate({
		parent,
		trail: nextTrail.length ? JSON.stringify(nextTrail) : undefined,
		page: undefined,
	});
}

/** Seed the filter draft from route state before opening the filter dialog. */
function openFilters(): void {
	filterDraft.name = queryString('q');
	filterDraft.releaseFrom = queryString('releaseFrom');
	filterDraft.releaseTo = queryString('releaseTo');
	filterDraft.addedFrom = queryString('addedFrom');
	filterDraft.addedTo = queryString('addedTo');
	filterDraft.genres = queryStrings('genre');
	filterDraft.genreMatch = queryString('genreMatch') === 'all' ? 'all' : 'any';
	filterDraft.actor = queryString('actor');
	filterDraft.director = queryString('director');
	showFilter.value = true;
}

/** Write the filter draft into route state and return to the first page. */
async function applyFilters(): Promise<void> {
	showFilter.value = false;
	searchText.value = filterDraft.name;
	await navigate({
		q: filterDraft.name || undefined,
		releaseFrom: filterDraft.releaseFrom || undefined,
		releaseTo: filterDraft.releaseTo || undefined,
		addedFrom: filterDraft.addedFrom || undefined,
		addedTo: filterDraft.addedTo || undefined,
		dateWindow: undefined,
		genre: filterDraft.genres.length ? filterDraft.genres : undefined,
		genreMatch: filterDraft.genres.length && filterDraft.genreMatch === 'all' ? 'all' : undefined,
		actor: filterDraft.actor || undefined,
		director: filterDraft.director || undefined,
		page: undefined,
	});
}

/** Reset every catalog filter and write the cleared state back to the route. */
async function clearFilters(): Promise<void> {
	Object.assign(filterDraft, {
		name: '',
		releaseFrom: '',
		releaseTo: '',
		addedFrom: '',
		addedTo: '',
		genres: [],
		genreMatch: 'any',
		actor: '',
		director: '',
	});
	await applyFilters();
}

/** Handle the search shortcut and close transient controls with Escape. */
function handleKeydown(event: KeyboardEvent): void {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
		event.preventDefault();
		searchInput.value?.focus();
	}
	if (event.key === 'Escape') {
		showMenu.value = false;
		showSort.value = false;
		showFilter.value = false;
		showReconciliation.value = false;
	}
}

/** Confirm and remove the current library. */
async function remove(): Promise<void> {
	showMenu.value = false;
	if (!confirm('Remove this library and its index? Media files will not be changed.')) {
		return;
	}

	await api.deleteLibrary(id.value);
	await librariesStore.load();
	await router.push('/libraries');
}

let liveRefreshTimer: number | undefined;
let searchTimer: number | undefined;
let refreshMediaAfterEvent = false;

/** Coalesce live library events while preserving whether catalog rows also need refreshing. */
function scheduleLiveRefresh(includeMedia: boolean): void {
	refreshMediaAfterEvent ||= includeMedia;
	window.clearTimeout(liveRefreshTimer);
	liveRefreshTimer = window.setTimeout(async () => {
		const refreshMedia = refreshMediaAfterEvent;
		refreshMediaAfterEvent = false;
		await loadLibrary();
		if (refreshMedia) {
			await loadMedia();
			await settleCatalogPosition('auto', false);
		}
	}, 100);
}

const unsubscribe = liveEvents.subscribe((event) => {
	if (event.type === 'system.ready') {
		scheduleLiveRefresh(true);
		return;
	}

	if (event.type !== 'library.changed' && event.type !== 'scan.changed') {
		return;
	}

	if (event.data.libraryId !== id.value) {
		return;
	}

	if (event.type === 'library.changed') {
		if (event.data.change === 'deleted') {
			void router.push('/libraries');
		}
		else {
			scheduleLiveRefresh(event.data.affectsProgramming === true);
		}
		return;
	}

	if (event.type === 'scan.changed') {
		if (event.data.status === 'running') {
			if (activeScanId.value !== event.data.scanId) {
				activeScanId.value = event.data.scanId;
				activeScanProgress.value = undefined;
				scheduleLiveRefresh(false);
			}
			if (event.data.progress) {
				activeScanProgress.value = event.data.progress;
			}
			return;
		}

		activeScanId.value = undefined;
		activeScanProgress.value = undefined;
		scheduleLiveRefresh(true);
	}
});

let loadedMediaState = mediaStateSignature();
watch(
	() => route.fullPath,
	async () => {
		searchText.value = queryString('q');
		if (initialLoading.value) {
			return;
		}

		const currentMediaState = mediaStateSignature();
		if (currentMediaState !== loadedMediaState) {
			loadedMediaState = currentMediaState;
			activeScrollAnchor.value = '';
			await loadMedia();
			const behavior = pendingAnchorBehavior ?? 'auto';
			pendingAnchorBehavior = null;
			await settleCatalogPosition(behavior, true);
			return;
		}

		if (ignoreNextAnchorRouteChange) {
			ignoreNextAnchorRouteChange = false;
			return;
		}

		const behavior = pendingAnchorBehavior ?? 'auto';
		pendingAnchorBehavior = null;
		await settleCatalogPosition(behavior, true);
	},
);
watch(searchText, (value) => {
	if (value === queryString('q')) {
		return;
	}

	window.clearTimeout(searchTimer);
	searchTimer = window.setTimeout(
		() => void navigate({ q: value || undefined, page: undefined }),
		300,
	);
});
watch(id, () => {
	loadedMediaState = mediaStateSignature();
	void loadInitial();
});
onBeforeUpdate(() => {
	anchorElements.clear();
	navigationButtons.clear();
});
onMounted(() => {
	window.addEventListener('keydown', handleKeydown);
	window.addEventListener('scroll', scheduleAnchorUpdate, { passive: true });
	window.addEventListener('resize', scheduleAnchorUpdate, { passive: true });
	void loadInitial();
});
onUnmounted(() => {
	window.removeEventListener('keydown', handleKeydown);
	window.removeEventListener('scroll', scheduleAnchorUpdate);
	window.removeEventListener('resize', scheduleAnchorUpdate);
	unsubscribe();
	resizeObserver?.disconnect();
	if (anchorUpdateFrame !== undefined) {
		cancelAnimationFrame(anchorUpdateFrame);
	}
	window.clearTimeout(programmaticScrollTimer);
	window.clearTimeout(liveRefreshTimer);
	window.clearTimeout(searchTimer);
});
</script>

<template>
	<LoadingState v-if="initialLoading" label="Loading library…" />
	<div v-else-if="loadError" class="notice error">
		{{ loadError }}
		<button class="button ghost" @click="loadInitial">Retry</button>
	</div>
	<section v-else-if="library" ref="libraryPage" class="library-page">
		<header ref="libraryHeader" class="library-page-header">
			<div>
				<p class="eyebrow">Libraries</p>
				<div class="title-row">
					<h1>{{ library.name }}</h1>
					<div class="action-menu">
						<button
							class="square-button"
							aria-label="Library actions"
							:aria-expanded="showMenu"
							@click="showMenu = !showMenu"
						>
							<MoreHorizontal :size="20" />
						</button>
						<div v-if="showMenu" class="action-popover">
							<button @click="scan"><RefreshCw :size="16" />Scan now</button>
							<span class="source-path" :title="library.sourceConfig.scanRoot">{{
								library.sourceConfig.scanRoot
							}}</span>
							<button class="danger-action" @click="remove">
								<Trash2 :size="16" />Remove library
							</button>
						</div>
					</div>
				</div>
			</div>
			<div class="library-header-tools">
				<label class="search-control">
					<Search :size="19" />
					<span class="sr-only">Search {{ library.name }}</span>
					<input
						ref="searchInput"
						v-model="searchText"
						:placeholder="`Search ${typeLabel.toLowerCase()}…`"
					/>
					<kbd>⌘ K</kbd>
				</label>
			</div>
		</header>

		<p v-if="message" class="notice">{{ message }}</p>
		<div v-if="sourceUnavailable" class="source-outage-banner" role="status">
			<span class="source-outage-icon"><Unplug :size="22" /></span>
			<div>
				<strong>{{ isScanRunning() ? 'Checking media source' : 'Media source may be offline' }}</strong>
				<p v-if="isScanRunning()">
					Moirai is checking <code>{{ library.sourceConfig.scanRoot }}</code> after the source
					was unavailable. Indexed media remains retained while the scan runs.
				</p>
				<p v-else>
					Moirai cannot currently access <code>{{ library.sourceConfig.scanRoot }}</code>. The
					disk may be disconnected or unmounted, or the network location may be offline.
					Indexed media is being retained until the source returns and a healthy scan completes.
				</p>
			</div>
			<button v-if="!isScanRunning()" class="button secondary" @click="scan">Scan again</button>
		</div>
		<div
			v-if="reconciliation && reconciliation.status !== 'idle'"
			class="reconciliation-banner"
		>
			<span class="reconciliation-icon"><AlertTriangle :size="22" /></span>
			<div>
				<strong>Library index needs review</strong>
				<p>{{ reconciliation.pendingRemovalCount }} indexed item(s) are awaiting reconciliation.</p>
			</div>
			<button class="button secondary" @click="showReconciliation = true">Review</button>
		</div>

		<section class="library-status-panel" aria-label="Library status">
			<div class="status-stat status-watcher">
				<span class="status-icon"><Unplug v-if="sourceUnavailable" :size="24" /><CircleCheck v-else :size="24" /></span>
				<div><span>Watcher</span><strong>{{ sourceUnavailable ? 'Source offline' : library.watcherStatus === 'fallback' ? 'Periodic scans' : library.watcherStatus }}</strong><small>{{ sourceUnavailable ? 'Waiting for the configured path' : library.watcherStatus === 'fallback' ? 'Live watching paused; scheduled scans remain active' : library.watcherEnabled ? 'Monitoring library' : 'Disabled' }}</small></div>
			</div>
			<div class="status-stat status-scan">
				<span class="status-icon" :class="{ spinning: isScanRunning() }"><RefreshCw :size="24" /></span>
				<div>
					<span>Scan status</span>
					<strong>{{ isScanRunning() ? 'Running' : sourceUnavailable ? 'Source unavailable' : latestScan?.status ?? 'Ready' }}</strong>
					<small>{{ isScanRunning() ? scanProgressDescription : sourceUnavailable ? 'Disk path cannot be accessed' : 'No scan in progress' }}</small>
					<div
						v-if="isScanRunning() && scanProgressPercent !== null"
						class="scan-progress-track"
						role="progressbar"
						aria-label="Library scan progress"
						aria-valuemin="0"
						aria-valuemax="100"
						:aria-valuenow="scanProgressPercent"
					>
						<i class="scan-progress-fill" :style="{ width: `${scanProgressPercent}%` }"></i>
					</div>
					<button v-if="isScanRunning()" class="status-inline-action" @click="cancelScan">Cancel scan</button>
				</div>
			</div>
			<div class="status-stat status-indexed">
				<span class="status-icon"><Layers3 :size="24" /></span>
				<div><span>Indexed</span><strong>{{ library.itemCount.toLocaleString() }}</strong><small>{{ typeLabel }}</small></div>
			</div>
			<div class="status-stat status-last-scan">
				<span class="status-icon"><Clock3 :size="24" /></span>
				<div><span>Last scan</span><strong>{{ formatDate(library.lastScanCompletedAt) }}</strong><small>{{ formatRelative(library.lastScanCompletedAt) }}</small></div>
			</div>
			<div class="status-stat status-change">
				<span class="status-icon"><Zap :size="24" /></span>
				<div><span>Last change</span><strong>{{ formatDate(library.lastChangeDetectedAt) }}</strong><small>{{ formatRelative(library.lastChangeDetectedAt) }}</small></div>
			</div>
		</section>

		<nav v-if="trail.length > 1" class="breadcrumbs" aria-label="Library location">
			<button v-for="(crumb, index) in trail" :key="crumb.id ?? 'root'" @click="jump(index)">{{ crumb.title }}</button>
		</nav>

		<div ref="catalogToolbar" class="catalog-toolbar">
			<div ref="navigationScroller" class="alphabet-filter" aria-label="Catalog navigation">
				<template v-if="sort === 'title'">
					<button v-for="key in alphabet" :key="key" :ref="(element) => setNavigationButton(key, element)" :class="{ active: activeNavigationKey === key }" :aria-current="activeNavigationKey === key ? 'location' : undefined" :disabled="!browse?.navigation.some((option) => option.key === key)" @click="navigateToKey(key)">{{ key }}</button>
				</template>
				<template v-else-if="sort === 'date-added'">
					<button v-for="option in [{ key: 'today', label: 'Today' }, { key: 'week', label: 'This Week' }, { key: 'month', label: 'This Month' }, { key: 'three-months', label: '3 Months' }, { key: 'six-months', label: 'Six Months' }, { key: 'older', label: 'Older' }]" :key="option.key" class="date-option" :class="{ active: activeNavigationKey === option.key }" :aria-current="activeNavigationKey === option.key ? 'location' : undefined" @click="selectDateWindow(option.key)">{{ option.label }}</button>
				</template>
				<template v-else>
					<button v-for="option in browse?.navigation ?? []" :key="option.key" :ref="(element) => setNavigationButton(option.key, element)" class="genre-option" :class="{ active: activeNavigationKey === option.key }" :aria-current="activeNavigationKey === option.key ? 'location' : undefined" @click="navigateToKey(option.key)">{{ option.label }}</button>
				</template>
			</div>
			<div class="action-menu sort-control">
				<button class="catalog-select wide" :aria-expanded="showSort" @click="showSort = !showSort">{{ sortLabel }} <ChevronDown :size="16" /></button>
				<div v-if="showSort" class="action-popover sort-popover">
					<button v-for="option in [{ value: 'title', label: 'Title' }, { value: 'date-added', label: 'Date Added' }, { value: 'genre', label: 'Genre' }] as const" :key="option.value" :class="{ selected: sort === option.value }" @click="selectSort(option.value)">{{ option.label }}</button>
					<button @click="toggleDirection"><ArrowDownAZ v-if="direction === 'asc'" :size="16" /><ArrowUpAZ v-else :size="16" />Reverse order</button>
				</div>
			</div>
			<button class="toolbar-button" :class="{ active: activeFilterCount > 0 }" @click="openFilters"><Filter :size="16" /> Filter <span v-if="activeFilterCount" class="filter-count">{{ activeFilterCount }}</span></button>
		</div>

		<section ref="catalogResults" class="catalog-results" :class="{ loading: mediaLoading }" aria-live="polite">
			<LoadingState v-if="mediaLoading && !browse" label="Loading media…" />
			<div v-else-if="entries.length" class="media-grid">
				<template v-for="(entry, index) in entries" :key="entry.key">
					<h2 v-if="entry.sectionLabel && isAnchorStart(index)" :ref="(element) => setAnchorElement(entry.navigationKey, element)" class="genre-heading catalog-anchor" :data-catalog-anchor="entry.navigationKey">{{ entry.sectionLabel }}</h2>
					<button v-if="entry.group" :ref="(element) => setEntryAnchor(index, entry.navigationKey, element)" type="button" class="media-card" :class="{ 'catalog-anchor': isAnchorStart(index) && !entry.sectionLabel }" :data-catalog-anchor="isAnchorStart(index) && !entry.sectionLabel ? entry.navigationKey : undefined" @click="enter(entry.group)">
						<span class="poster"><Asterisk class="poster-placeholder" :size="38" /><img v-if="entry.group.artworkUrl" :src="artworkVariantUrl(entry.group.artworkUrl, 'card')" :srcset="artworkSrcset(entry.group.artworkUrl, 'card')" :alt="`${entry.group.title} artwork`" loading="lazy" decoding="async" @error="hideBrokenImage" /></span>
						<span class="media-card-copy"><span class="media-card-title">{{ entry.group.title }}</span><span class="media-card-subtitle">{{ mediaGroupSubtitle(library.typeKey, entry.group) || entry.group.kind }}</span><MoreHorizontal class="card-menu-icon" :size="16" /></span>
					</button>
					<RouterLink v-else-if="entry.item" :ref="(element) => setEntryAnchor(index, entry.navigationKey, element)" class="media-card" :class="{ 'catalog-anchor': isAnchorStart(index) && !entry.sectionLabel }" :data-catalog-anchor="isAnchorStart(index) && !entry.sectionLabel ? entry.navigationKey : undefined" :to="`/libraries/${library.id}/items/${entry.item.id}`">
						<span class="poster"><Asterisk class="poster-placeholder" :size="38" /><img v-if="entry.item.artworkUrl" :src="artworkVariantUrl(entry.item.artworkUrl, 'card')" :srcset="artworkSrcset(entry.item.artworkUrl, 'card')" :alt="`${entry.item.title} artwork`" loading="lazy" decoding="async" @error="hideBrokenImage" /></span>
						<span class="media-card-copy"><span class="media-card-title">{{ entry.item.title }}</span><span class="media-card-subtitle">{{ mediaItemSubtitle(library.typeKey, entry.item) || entry.item.kind }}</span><small v-if="entry.item.availability !== 'available'" class="availability-warning">Temporarily unavailable</small><MoreHorizontal class="card-menu-icon" :size="16" /><span class="metadata-indicator" :data-status="entry.item.metadataStatus" :data-availability="entry.item.availability" :title="entry.item.availability === 'available' ? `Metadata: ${entry.item.metadataStatus}` : 'Media temporarily unavailable'"><CircleHelp v-if="entry.item.availability !== 'available'" :size="11" /><Check v-else :size="10" /></span></span>
					</RouterLink>
				</template>
			</div>
			<div v-else class="empty-state"><h3>No matching media</h3><p>Try changing the search or filters, or scan the library again.</p></div>
		</section>

		<footer v-if="pagination" class="catalog-footer">
			<span>Showing {{ pagination.totalEntries ? (page - 1) * pagination.pageSize + 1 : 0 }}–{{ Math.min(page * pagination.pageSize, pagination.totalEntries) }} of {{ pagination.totalEntries.toLocaleString() }}</span>
			<div class="pagination-placeholder"><button :disabled="page <= 1" aria-label="Previous page" @click="navigate({ page: page - 1 || undefined })"><ChevronLeft :size="16" /></button><button v-for="pageNumber in pageButtons" :key="pageNumber" :class="{ active: pageNumber === page }" @click="navigate({ page: pageNumber === 1 ? undefined : pageNumber })">{{ pageNumber }}</button><button :disabled="page >= pagination.totalPages" aria-label="Next page" @click="navigate({ page: page + 1 })"><ChevronRight :size="16" /></button></div>
			<span>{{ pagination.pageSize }} per page</span>
		</footer>

		<details class="diagnostics"><summary>Scan history</summary><article v-for="run in scans" :key="run.id"><StatusPill :value="run.status" /><span>{{ new Date(run.startedAt).toLocaleString() }}</span><span>{{ run.discoveredCount }} found · {{ run.changedCount }} changed · {{ run.removedCount }} removed</span><ul v-if="run.issues.length"><li v-for="issue in run.issues" :key="`${issue.code}:${issue.path}`">{{ issue.code }} — {{ issue.path ?? issue.message }}</li></ul></article></details>

		<LibraryReconciliationModal v-if="showReconciliation && reconciliation" :reconciliation="reconciliation" :busy="reconciliationBusy" @close="showReconciliation = false" @scan="scan" @reconcile="reconcile" />
		<LibraryFilterModal v-if="showFilter" :draft="filterDraft" :genres="genres" @update:draft="Object.assign(filterDraft, $event)" @apply="applyFilters" @clear="clearFilters" @close="showFilter = false" />
	</section>
</template>
