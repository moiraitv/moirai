<script setup lang="ts">
import { libraryScanAttention } from '../library-scan-issues';
import { useCatalogSelection } from '../composables/useCatalogSelection';
import { useDisclosureState } from '../disclosure-state';
import PageHelpButton from '../components/PageHelpButton.vue';
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
import { errorMessage } from '../error-message';
import { requestConfirmation } from '../confirmation';
import {
	ArrowDownAZ,
	ArrowUpAZ,
	AlertTriangle,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	CircleCheck,
	Clock3,
	Filter,
	Layers3,
	ListPlus,
	RefreshCw,
	Search,
	Settings,
	Unplug,
	X,
	Zap,
} from '@lucide/vue';
import type {
	Library,
	MediaBrowseResult,
	MediaGenreFacet,
	MediaGroup,
	MediaSort,
	ScanProgress,
	ScanRun,
	LibraryReconciliation,
	ReconciliationAction,
	ProgramItemAddition,
	ProgramGroupAddition,
	ProgramGroupAdditionResult,
	ProgramItemAdditionResult,
} from '@moirai/shared';
import { api, type MediaQuery } from '../api';
import { activeCatalogAnchor, breadcrumbTargetTrail } from '../catalog-navigation';
import { countLabel } from '../count-label';
import {
	buildCatalogVirtualRows,
	catalogAnchorRowIndex,
	catalogColumnCount,
} from '../catalog-virtualization';
import LoadingState from '../components/LoadingState.vue';
import ActionMenu from '../components/ActionMenu.vue';
import AnimatedDisclosure from '../components/AnimatedDisclosure.vue';
import TransientToast from '../components/TransientToast.vue';
import LibraryFilterModal from '../components/library/LibraryFilterModal.vue';
import LibrarySettingsModal from '../components/library/LibrarySettingsModal.vue';
import VirtualLibraryCatalog from '../components/library/VirtualLibraryCatalog.vue';
import {
	catalogProgramQuery,
	emptyLibraryFilterDraft,
	type LibraryFilterDraft,
} from '../components/library/library-filter';
import LibraryReconciliationModal from '../components/library/LibraryReconciliationModal.vue';
import StatusPill from '../components/StatusPill.vue';
import AddItemsToProgramModal from '../components/programs/AddItemsToProgramModal.vue';
import ProgramAdditionToast from '../components/programs/ProgramAdditionToast.vue';
import { liveEvents } from '../live-events';
import { isLibrarySourceUnavailable } from '../library-health';
import { shiftCalendarMonths } from '../date-key';
import { useSelectionToolbarTransition } from '../selection-toolbar-transition';
import { useLibrariesStore } from '../stores/libraries';

const route = useRoute();
const router = useRouter();
const librariesStore = useLibrariesStore();
const id = computed(() => String(route.params.id));
const library = ref<Library>();
const scans = ref<ScanRun[]>([]);
const scanHistoryOpen = useDisclosureState('library-scan-history', false);
const filterModalInstance = ref(0);
const reconciliation = ref<LibraryReconciliation>();
const genres = ref<MediaGenreFacet[]>([]);
const browse = ref<MediaBrowseResult>();
const latestScan = computed(() => scans.value[0]);
const scanAttention = computed(() => libraryScanAttention(library.value, scans.value));
const currentScanIssues = computed(() => scanAttention.value.issues);
const activeScanId = ref<string>();
const activeScanProgress = ref<ScanProgress>();
const showScanIssues = useDisclosureState('library-scan-issues', false);
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
const catalogControlsStack = ref<HTMLElement>();
const selectionToolbarSlot = ref<HTMLElement>();
const catalogResults = ref<HTMLElement>();
const virtualCatalog = ref<InstanceType<typeof VirtualLibraryCatalog>>();
const catalogWidth = ref(0);
const catalogScrollMargin = ref(0);
const catalogScrollPadding = ref(0);
const navigationScroller = ref<HTMLElement>();
const searchText = ref(queryString('q'));
const message = ref('');
const actionError = ref('');
const initialLoading = ref(true);
const mediaLoading = ref(false);
const scanRequestPending = ref(false);
const loadError = ref('');
const showSettings = ref(false);
const showFilter = ref(false);
const showReconciliation = ref(false);
const {
	active: selectionMode,
	mounted: selectionToolbarMounted,
	revealed: selectionToolbarRevealed,
	show: showSelectionToolbar,
	hide: hideSelectionToolbar,
	finish: finishSelectionToolbarState,
	reset: resetSelectionToolbar,
	dispose: disposeSelectionToolbar,
} = useSelectionToolbarTransition();
const selectionToolbarMotionActive = ref(false);
const selectionToolbarShift = ref(0);
const selectedIds = ref<string[]>([]);
const programSelection = ref<ProgramItemAddition['selection'] | ProgramGroupAddition['selection'] | null>(null);
const programAdditionResult = ref<ProgramItemAdditionResult | ProgramGroupAdditionResult | null>(null);
const reconciliationBusy = ref(false);
const alphabet = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const navigationButtons = new Map<string, HTMLElement>();
const activeScrollAnchor = ref('');
/** Breadcrumb entry stored in route state for hierarchical catalog browsing. */
type CatalogScrollBehavior = 'auto' | 'smooth';

const filterDraft = reactive<LibraryFilterDraft>(emptyLibraryFilterDraft());

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
const paginationWidth = ref(typeof window === 'undefined' ? 1024 : window.innerWidth);
const catalogColumns = computed(() =>
	catalogColumnCount(catalogWidth.value, paginationWidth.value));
const catalogRows = computed(() => buildCatalogVirtualRows(entries.value, catalogColumns.value));
const { selectionKind, hasGroups, hasItems, pageSelectionIds, selectedIdSet, allPageSelected,
	toggleSelectedEntry, togglePageSelection } = useCatalogSelection(entries, selectedIds);
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
			queryString('minimumRating'),
			queryString('minimumUserRating'),
			queryString('addedFrom') || queryString('addedTo') || dateWindow.value,
			queryStrings('genre').length || queryStrings('excludeGenre').length ? 'genre' : '',
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
	const visibleCount = paginationWidth.value >= 1200 ? 11 : paginationWidth.value >= 700 ? 7 : 3;
	const interiorCount = Math.max(1, visibleCount - 2);
	let start = Math.max(2, current - Math.floor(interiorCount / 2));
	let end = Math.min(total - 1, start + interiorCount - 1);
	start = Math.max(2, end - interiorCount + 1);
	const values = [1];
	for (let value = start; value <= end; value += 1) {
		values.push(value);
	}
	if (total > 1) {
		values.push(total);
	}

	return [...new Set(values)];
});

/** Return whether a visual gap belongs before one pagination number. */
function pageGapBefore(index: number): boolean {
	return index > 0 && pageButtons.value[index]! - pageButtons.value[index - 1]! > 1;
}

/** Return whether the latest scan has started but not completed. */
function isScanRunning(): boolean {
	return Boolean(
		scanRequestPending.value
		|| activeScanId.value
		|| (
			library.value?.lastScanStartedAt
			&& (!library.value.lastScanCompletedAt
				|| library.value.lastScanStartedAt > library.value.lastScanCompletedAt)
		),
	);
}

/** Format an optional activity timestamp in the viewer's locale. */
function formatDate(value: string | null | undefined): string {
	return value
		? new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
		}).format(new Date(value))
		: 'Not yet';
}

/** Combine local activity time with its relative age beneath the date. */
function formatActivityTime(value: string | null | undefined): string {
	if (!value) {
		return formatRelative(value);
	}

	const formatter = new Intl.DateTimeFormat(undefined, {
		hour: 'numeric', minute: '2-digit',
	});
	const time = formatter.formatToParts(new Date(value))
		.map((part) => part.type === 'dayPeriod' ? part.value.toLocaleLowerCase() : part.value)
		.join('');
	return `${time} • ${formatRelative(value)}`;
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

	const sixMonths = shiftCalendarMonths(today, -6);
	if (key === 'older') {
		return { addedBefore: sixMonths.toISOString() };
	}

	const start = shiftCalendarMonths(today, key === 'three-months' ? -3 : -6);
	return { addedFrom: start.toISOString() };
}

/** Build the catalog API query represented by current route state. */
function currentMediaQuery(): MediaQuery {
	const releaseFrom = Number(queryString('releaseFrom'));
	const releaseTo = Number(queryString('releaseTo'));
	const minimumRating = Number(queryString('minimumRating'));
	const minimumUserRating = Number(queryString('minimumUserRating'));
	const windowBounds = dateWindow.value ? dateWindowBounds(dateWindow.value) : {};
	return {
		parentId: parentId.value,
		page: page.value,
		pageSize: 100,
		sort: sort.value,
		direction: direction.value,
		name: queryString('q') || undefined,
		releaseYearFrom: releaseFrom || undefined,
		releaseYearTo: releaseTo || undefined,
		minimumRating: queryString('minimumRating') ? minimumRating : undefined,
		minimumUserRating: queryString('minimumUserRating') ? minimumUserRating : undefined,
		addedFrom: windowBounds.addedFrom ?? localDay(queryString('addedFrom')),
		addedBefore: windowBounds.addedBefore ?? localDay(queryString('addedTo'), true),
		genres: queryStrings('genre'),
		excludedGenres: queryStrings('excludeGenre'),
		genreMatch: queryString('genreMatch') === 'any' ? 'any' : 'all',
		actor: queryString('actor') || undefined,
		director: queryString('director') || undefined,
	};
}

/** Enter page-local selection without retaining an earlier catalog page. */
function beginSelection(): void {
	selectionKind.value = hasGroups.value ? 'groups' : 'items';
	selectedIds.value = [];
	selectionToolbarMotionActive.value = true;
	showSelectionToolbar();
	void nextTick(() => {
		selectionToolbarShift.value = selectionToolbarSlot.value?.getBoundingClientRect().height ?? 0;
	});
}

/** Leave selection mode and discard its page-local identifiers. */
function cancelSelection(): void {
	selectedIds.value = [];
	selectionToolbarMotionActive.value = selectionToolbarMounted.value;
	hideSelectionToolbar();
}

/** Reconcile sticky geometry once selection-toolbar motion has finished. */
function finishSelectionToolbarTransition(event: TransitionEvent): void {
	finishSelectionToolbarState(event);
	if (event.target !== event.currentTarget || event.propertyName !== 'opacity') {
		return;
	}

	selectionToolbarMotionActive.value = false;
	requestAnimationFrame(updateStickyMetrics);
}

/** Open the destination dialog for the explicitly selected cards. */
function addSelectedItems(): void {
	if (selectedIds.value.length > 0) {
		programSelection.value = selectionKind.value === 'groups'
			? { type: 'groups', groupIds: [...selectedIds.value] }
			: { type: 'items', itemIds: [...selectedIds.value] };
	}
}

/** Open the destination dialog for every recursive item matching the current catalog state. */
function addAllMatchingItems(): void {
	programSelection.value = { type: 'query', query: catalogProgramQuery(currentMediaQuery()) };
}

/** Close selection UI and retain an accessible link to the changed program. */
function finishProgramAddition(result: ProgramItemAdditionResult | ProgramGroupAdditionResult): void {
	programSelection.value = null;
	programAdditionResult.value = result;
	cancelSelection();
}

/** Create a stable signature for route-driven catalog state. */
function mediaStateSignature(): string {
	return JSON.stringify(
		Object.entries(route.query)
			.filter(([key]) => key !== 'anchor')
			.sort(([left], [right]) => left.localeCompare(right)),
	);
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
	if (!libraryPage.value || !libraryHeader.value || !catalogControlsStack.value) {
		return 0;
	}

	const applicationOffset = Number.parseFloat(
		getComputedStyle(libraryPage.value).getPropertyValue('--app-header-offset'),
	);
	return (
		(Number.isFinite(applicationOffset) ? applicationOffset : 0)
		+ libraryHeader.value.getBoundingClientRect().height
		+ catalogControlsStack.value.getBoundingClientRect().height
	);
}

/** Publish measured sticky-header heights for layout and scroll calculations. */
function updateStickyMetrics(): void {
	if (!libraryPage.value || !libraryHeader.value || !catalogControlsStack.value) {
		return;
	}

	const headerHeight = libraryHeader.value.getBoundingClientRect().height;
	const controlsHeight = catalogControlsStack.value.getBoundingClientRect().height;
	libraryPage.value.style.setProperty(
		'--library-header-height',
		`${headerHeight}px`,
	);
	libraryPage.value.style.setProperty(
		'--catalog-controls-height',
		`${controlsHeight}px`,
	);
	catalogScrollPadding.value = stickyBoundary();
	if (catalogResults.value) {
		catalogScrollMargin.value
			= window.scrollY + catalogResults.value.getBoundingClientRect().top;
	}
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
	const rowIndex = catalogAnchorRowIndex(catalogRows.value, key);
	if (rowIndex < 0) {
		return false;
	}

	const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
		? 'auto'
		: requestedBehavior;
	activeScrollAnchor.value = key;
	revealNavigationButton(key, behavior);
	programmaticScroll = true;
	window.clearTimeout(programmaticScrollTimer);
	virtualCatalog.value?.scrollToRow(rowIndex, behavior);
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

	const positions = virtualCatalog.value?.anchorPositions(window.scrollY) ?? [];
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
let catalogResizeObserver: ResizeObserver | undefined;
/** Watch sticky header sizes and refresh catalog scroll geometry. */
function observeStickyElements(): void {
	resizeObserver?.disconnect();
	if (!libraryHeader.value || !catalogControlsStack.value) {
		return;
	}

	resizeObserver = new ResizeObserver(updateStickyMetrics);
	resizeObserver.observe(libraryHeader.value);
	resizeObserver.observe(catalogControlsStack.value);
	updateStickyMetrics();
}

/** Watch catalog width so responsive rows can be regrouped and remeasured. */
function observeCatalogWidth(): void {
	catalogResizeObserver?.disconnect();
	if (!catalogResults.value) {
		return;
	}

	catalogResizeObserver = new ResizeObserver(([entry]) => {
		const nextWidth = entry?.contentRect.width ?? 0;
		if (Math.abs(nextWidth - catalogWidth.value) < 0.5) {
			return;
		}

		catalogWidth.value = nextWidth;
	});
	catalogResizeObserver.observe(catalogResults.value);
	catalogWidth.value = catalogResults.value.getBoundingClientRect().width;
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

/** Load the routed catalog page, optionally retaining selections that remain visible. */
async function loadMedia(preserveSelection = false): Promise<void> {
	if (!preserveSelection) {
		selectedIds.value = [];
	}
	mediaLoading.value = true;
	try {
		browse.value = await api.media(id.value, currentMediaQuery());
		if (!preserveSelection) {
			selectionKind.value = hasGroups.value ? 'groups' : 'items';
		}
		if (preserveSelection) {
			const visibleItemIds = new Set(pageSelectionIds.value);
			selectedIds.value = selectedIds.value.filter((itemId) =>
				visibleItemIds.has(itemId));
		}
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
	observeCatalogWidth();
	await settleCatalogPosition('auto', false);
}

/** Request a library scan and surface its current status. */
async function scan(): Promise<void> {
	if (isScanRunning()) {
		return;
	}

	scanRequestPending.value = true;
	message.value = '';
	actionError.value = '';
	try {
		await api.scanLibrary(id.value);
		message.value = 'Library scan started';
		window.setTimeout(() => void loadLibrary(), 300);
	}
	catch (cause) {
		actionError.value = `Unable to start library scan: ${errorMessage(cause)}`;
	}
	finally {
		scanRequestPending.value = false;
	}
}

/** Ask the active scanner to stop without discarding the existing index. */
async function cancelScan(): Promise<void> {
	message.value = '';
	actionError.value = '';
	try {
		await api.cancelLibraryScan(id.value);
		message.value = 'Scan cancellation requested';
		window.setTimeout(() => void loadLibrary(), 300);
	}
	catch (cause) {
		actionError.value = `Unable to cancel library scan: ${errorMessage(cause)}`;
	}
}

/** Apply the selected source or removal reconciliation action. */
async function reconcile(action: ReconciliationAction['action']): Promise<void> {
	const current = reconciliation.value;
	const libraryId = id.value;
	if (!current?.revision) {
		return;
	}

	if (
		action === 'confirm-removals'
		&& !(await requestConfirmation({
			key: `confirm-library-removals:${libraryId}:${current.revision}`,
			title: 'Permanently Remove Missing Items?',
			message: `Permanently remove ${countLabel(current.pendingRemovalCount, 'missing item')} from the index?`,
			confirmLabel: 'Remove Missing Items',
			destructive: true,
		}))
	) {
		return;
	}

	if (
		action === 'accept-source'
		&& !(await requestConfirmation({
			key: `accept-library-source:${libraryId}:${current.revision}`,
			title: 'Replace Library Index?',
			message: 'Replace this library index with the reviewed source? Media files will not be changed.',
			confirmLabel: 'Replace Index',
			destructive: true,
		}))
	) {
		return;
	}

	reconciliationBusy.value = true;
	actionError.value = '';
	try {
		await api.reconcileLibrary(libraryId, { action, revision: current.revision });
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
		actionError.value = errorMessage(cause);
	}
	finally {
		reconciliationBusy.value = false;
	}
}

/** Change catalog ordering, restore its default direction, and return to the first page. */
async function selectSort(value: MediaSort): Promise<void> {
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
	filterModalInstance.value += 1;
	filterDraft.name = queryString('q');
	filterDraft.releaseFrom = queryString('releaseFrom');
	filterDraft.releaseTo = queryString('releaseTo');
	filterDraft.minimumRating = queryString('minimumRating');
	filterDraft.minimumUserRating = queryString('minimumUserRating');
	filterDraft.addedFrom = queryString('addedFrom');
	filterDraft.addedTo = queryString('addedTo');
	filterDraft.genres = queryStrings('genre');
	filterDraft.excludedGenres = queryStrings('excludeGenre');
	filterDraft.genreMatch = queryString('genreMatch') === 'any' ? 'any' : 'all';
	filterDraft.actor = queryString('actor');
	filterDraft.director = queryString('director');
	showFilter.value = true;
}

/** Write the filter draft into route state and return to the first page. */
async function applyFilters(draft: LibraryFilterDraft): Promise<void> {
	showFilter.value = false;
	searchText.value = draft.name;
	await navigate({
		q: draft.name || undefined,
		releaseFrom: draft.releaseFrom || undefined,
		releaseTo: draft.releaseTo || undefined,
		minimumRating: draft.minimumRating || undefined,
		minimumUserRating: draft.minimumUserRating || undefined,
		addedFrom: draft.addedFrom || undefined,
		addedTo: draft.addedTo || undefined,
		dateWindow: undefined,
		genre: draft.genres.length ? draft.genres : undefined,
		excludeGenre: draft.excludedGenres.length ? draft.excludedGenres : undefined,
		genreMatch: (draft.genres.length || draft.excludedGenres.length)
			&& draft.genreMatch === 'any' ? 'any' : undefined,
		actor: draft.actor || undefined,
		director: draft.director || undefined,
		page: undefined,
	});
}

/** Handle the search shortcut and close transient controls with Escape. */
function handleKeydown(event: KeyboardEvent): void {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
		event.preventDefault();
		searchInput.value?.focus();
	}
	if (event.key === 'Escape') {
		showSettings.value = false;
		showFilter.value = false;
		showReconciliation.value = false;
	}
}

/** Apply an updated library returned by the settings workflow. */
async function finishSettings(updated: Library): Promise<void> {
	library.value = updated;
	showSettings.value = false;
	actionError.value = '';
	message.value = 'Library settings saved. Sync the library to apply source changes to the index.';
	await librariesStore.load();
}

/** Refresh shared state and leave the deleted library route. */
async function finishDeletion(): Promise<void> {
	await librariesStore.load();
	await router.push('/libraries');
}

/** Refresh width-dependent pagination and sticky catalog measurements. */
function handleResize(): void {
	paginationWidth.value = window.innerWidth;
	scheduleAnchorUpdate();
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
			await loadMedia(true);
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
watch(catalogColumns, async () => {
	await nextTick();
	updateStickyMetrics();
});
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
	// Discard actions captured for the previous library before loading the new route.
	resetSelectionToolbar();
	selectionToolbarMotionActive.value = false;
	selectedIds.value = [];
	programSelection.value = null;
	programAdditionResult.value = null;
	loadedMediaState = mediaStateSignature();
	void loadInitial();
});
onBeforeUpdate(() => {
	navigationButtons.clear();
});
onMounted(() => {
	window.addEventListener('keydown', handleKeydown);
	window.addEventListener('scroll', scheduleAnchorUpdate, { passive: true });
	window.addEventListener('resize', handleResize, { passive: true });
	void loadInitial();
});
onUnmounted(() => {
	window.removeEventListener('keydown', handleKeydown);
	window.removeEventListener('scroll', scheduleAnchorUpdate);
	window.removeEventListener('resize', handleResize);
	unsubscribe();
	resizeObserver?.disconnect();
	catalogResizeObserver?.disconnect();
	if (anchorUpdateFrame !== undefined) {
		cancelAnimationFrame(anchorUpdateFrame);
	}
	disposeSelectionToolbar();
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
					<PageHelpButton label="Libraries" />
				</div>
			</div>
			<div class="library-header-tools">
				<button class="square-button library-header-icon-button" aria-label="Sync library" :disabled="isScanRunning()" @click="scan"><RefreshCw :size="20" :class="{ spinning: isScanRunning() }" /></button>
				<button class="square-button library-header-icon-button" aria-label="Library settings" @click="showSettings = true"><Settings :size="20" /></button>
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

		<div class="library-status-surface">
			<p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
			<div v-if="scanAttention.count > 0" class="reconciliation-banner library-warning-banner" role="alert">
				<span class="reconciliation-icon"><AlertTriangle :size="22" /></span>
				<div>
					<strong>Library scan needs attention</strong>
					<p>{{ scanAttention.count }} scan {{ scanAttention.count === 1 ? 'issue requires' : 'issues require' }} review.</p>
					<Transition name="moirai-collapse">
						<ul v-if="showScanIssues && currentScanIssues.length" class="library-warning-issues">
							<li v-for="issue in currentScanIssues" :key="`${issue.code}:${issue.path}:${issue.message}`"><strong>{{ issue.code }}</strong><span>{{ issue.path ?? issue.message }}</span><small v-if="issue.path">{{ issue.message }}</small></li>
						</ul>
						<p v-else-if="showScanIssues">Detailed issues are no longer retained. Run a library sync to refresh the warning state.</p>
					</Transition>
				</div>
				<button v-if="currentScanIssues.length" type="button" class="button secondary" :aria-expanded="showScanIssues" @click="showScanIssues = !showScanIssues">{{ showScanIssues ? 'Hide Issues' : 'Review Issues' }}</button>
			</div>
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
				<button v-if="!isScanRunning()" class="button secondary" @click="scan">Scan Again</button>
			</div>
			<div
				v-if="reconciliation && reconciliation.status !== 'idle'"
				class="reconciliation-banner"
			>
				<span class="reconciliation-icon"><AlertTriangle :size="22" /></span>
				<div>
					<strong>Library index needs review</strong>
					<p>{{ countLabel(reconciliation.pendingRemovalCount, 'indexed item') }} {{ reconciliation.pendingRemovalCount === 1 ? 'is' : 'are' }} awaiting reconciliation.</p>
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
						<button v-if="isScanRunning()" class="status-inline-action" @click="cancelScan">Cancel Scan</button>
					</div>
				</div>
				<div class="status-stat status-indexed">
					<span class="status-icon"><Layers3 :size="24" /></span>
					<div><span>Indexed</span><strong>{{ library.itemCount.toLocaleString() }}</strong><small>{{ typeLabel }}</small></div>
				</div>
				<div class="status-stat status-last-scan">
					<span class="status-icon"><Clock3 :size="24" /></span>
					<div><span>Last scan</span><strong>{{ formatDate(library.lastScanCompletedAt) }}</strong><small>{{ formatActivityTime(library.lastScanCompletedAt) }}</small></div>
				</div>
				<div class="status-stat status-change">
					<span class="status-icon"><Zap :size="24" /></span>
					<div><span>Last change</span><strong>{{ formatDate(library.lastChangeDetectedAt) }}</strong><small>{{ formatActivityTime(library.lastChangeDetectedAt) }}</small></div>
				</div>
			</section>
		</div>

		<div
			ref="catalogControlsStack"
			class="catalog-controls-stack"
			:style="{ '--selection-toolbar-shift': `${selectionToolbarMounted ? selectionToolbarShift : 0}px` }"
		>
			<nav v-if="trail.length > 1" class="breadcrumbs" aria-label="Library location">
				<button v-for="(crumb, index) in trail" :key="crumb.id ?? 'root'" @click="jump(index)">{{ crumb.title }}</button>
			</nav>
			<div class="catalog-toolbar">
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
				<ActionMenu class="sort-control" :label="`Sort by: ${sortLabel}`" trigger-class="catalog-select wide" menu-class="sort-popover">
					<template #trigger>{{ sortLabel }} <ChevronDown :size="16" /></template>
					<button v-for="option in [{ value: 'title', label: 'Title' }, { value: 'date-added', label: 'Date Added' }, { value: 'genre', label: 'Genre' }] as const" :key="option.value" type="button" :class="{ selected: sort === option.value }" @click="selectSort(option.value)">{{ option.label }}</button>
					<button type="button" @click="toggleDirection"><ArrowDownAZ v-if="direction === 'asc'" :size="16" /><ArrowUpAZ v-else :size="16" />Reverse Order</button>
				</ActionMenu>
				<button
					type="button"
					class="toolbar-button catalog-icon-button"
					:class="{ active: activeFilterCount > 0 }"
					aria-label="Filter media"
					title="Filter media"
					@click="openFilters"
				>
					<Filter :size="18" />
					<span v-if="activeFilterCount" class="filter-count">{{ activeFilterCount }}</span>
				</button>
				<button
					type="button"
					class="toolbar-button catalog-icon-button catalog-selection-toggle"
					:class="{ active: selectionMode }"
					:aria-pressed="selectionMode"
					:aria-label="selectionMode ? 'Cancel selection' : hasGroups ? 'Select groups' : 'Select items'"
					:title="selectionMode ? 'Cancel selection' : hasGroups ? 'Select groups' : 'Select items'"
					@click="selectionMode ? cancelSelection() : beginSelection()"
				>
					<X v-if="selectionMode" :size="18" />
					<ListPlus v-else :size="18" />
				</button>
			</div>
			<div v-show="selectionToolbarMounted" ref="selectionToolbarSlot" class="catalog-selection-toolbar-slot" :class="{ 'is-revealed': selectionToolbarRevealed }">
				<div class="catalog-selection-toolbar-clip">
					<div
						class="catalog-selection-toolbar"
						role="toolbar"
						:aria-label="selectionKind === 'groups' ? 'Group selection' : 'Item selection'"
						@transitionend="finishSelectionToolbarTransition"
					>
						<div class="catalog-selection-primary">
							<select v-if="hasGroups && hasItems" v-model="selectionKind" aria-label="Selection type" @change="selectedIds = []"><option value="groups">Groups</option><option value="items">Items</option></select>
							<strong>{{ selectedIds.length }} selected</strong>
							<button
								type="button"
								class="toolbar-button catalog-selection-action"
								:disabled="selectedIds.length === 0"
								@click="addSelectedItems"
							>
								<ListPlus :size="15" /> Add Selected
							</button>
							<button
								type="button"
								class="toolbar-button catalog-selection-action"
								:disabled="mediaLoading || !browse || entries.length === 0"
								@click="addAllMatchingItems"
							>
								<Layers3 :size="15" /> {{ selectionKind === 'groups' ? 'Add All Items' : 'Add All' }}
							</button>
						</div>
						<button
							type="button"
							class="toolbar-button catalog-selection-page-action"
							:disabled="pageSelectionIds.length === 0"
							@click="togglePageSelection"
						>
							{{ allPageSelected ? 'Clear Page' : 'Select Page' }}
						</button>
					</div>
				</div>
			</div>
		</div>

		<section
			ref="catalogResults"
			class="catalog-results"
			:class="{
				loading: mediaLoading,
				'selection-layout-entering': selectionToolbarMotionActive && selectionMode && !selectionToolbarRevealed,
				'selection-layout-opening': selectionToolbarMotionActive && selectionMode && selectionToolbarRevealed,
				'selection-layout-leaving': selectionToolbarMotionActive && !selectionMode && selectionToolbarMounted,
			}"
			:style="{ '--selection-toolbar-shift': `${selectionToolbarShift}px` }"
			:aria-live="mediaLoading || !entries.length ? 'polite' : 'off'"
		>
			<LoadingState v-if="mediaLoading && !browse" label="Loading media…" />
			<VirtualLibraryCatalog
				v-else-if="entries.length"
				ref="virtualCatalog"
				:rows="catalogRows"
				:catalog-width="catalogWidth"
				:column-count="catalogColumns"
				:scroll-margin="catalogScrollMargin"
				:scroll-padding="catalogScrollPadding"
				:selection-mode="selectionMode"
				:selected-item-ids="selectedIdSet"
				:selection-kind="selectionKind"
				:library-id="library.id"
				:library-type="library.typeKey"
				@enter="enter"
				@toggle="toggleSelectedEntry"
			/>
			<div v-else class="empty-state"><h3>No matching media</h3><p>Try changing the search or filters, or scan the library again.</p></div>
		</section>

		<footer v-if="pagination" class="catalog-footer">
			<span>Showing {{ pagination.totalEntries ? (page - 1) * pagination.pageSize + 1 : 0 }}–{{ Math.min(page * pagination.pageSize, pagination.totalEntries) }} of {{ pagination.totalEntries.toLocaleString() }}</span>
			<div class="pagination-placeholder"><button :disabled="page <= 1" aria-label="Previous page" @click="navigate({ page: page - 1 || undefined })"><ChevronLeft :size="16" /></button><template v-for="(pageNumber, index) in pageButtons" :key="pageNumber"><span v-if="pageGapBefore(index)" class="pagination-gap">…</span><button :class="{ active: pageNumber === page }" @click="navigate({ page: pageNumber === 1 ? undefined : pageNumber })">{{ pageNumber }}</button></template><button :disabled="page >= pagination.totalPages" aria-label="Next page" @click="navigate({ page: page + 1 })"><ChevronRight :size="16" /></button></div>
			<span>{{ pagination.pageSize }} per page</span>
		</footer>

		<AnimatedDisclosure v-model="scanHistoryOpen" class="diagnostics"><template #summary><span>Scan history</span></template><article v-for="run in scans" :key="run.id"><StatusPill :value="run.status" /><span>{{ new Date(run.startedAt).toLocaleString() }}</span><span>{{ run.discoveredCount }} found · {{ run.changedCount }} changed · {{ run.removedCount }} removed</span><ul v-if="run.issues.length"><li v-for="issue in run.issues" :key="`${issue.code}:${issue.path}`">{{ issue.code }} — {{ issue.path ?? issue.message }}</li></ul></article></AnimatedDisclosure>

		<LibraryReconciliationModal v-if="showReconciliation && reconciliation" :reconciliation="reconciliation" :busy="reconciliationBusy" @close="showReconciliation = false" @scan="scan" @reconcile="reconcile" />
		<LibrarySettingsModal v-if="showSettings" :library="library" @close="showSettings = false" @saved="finishSettings" @deleted="finishDeletion" />
		<LibraryFilterModal v-if="showFilter" :key="filterModalInstance" :library-id="id" :draft="filterDraft" :genres="genres" @apply="applyFilters" @close="showFilter = false" />
		<AddItemsToProgramModal v-if="programSelection" :library-id="library.id" :library-name="library.name" :selection="programSelection" @added="finishProgramAddition" @close="programSelection = null" />
		<ProgramAdditionToast v-if="programAdditionResult" :result="programAdditionResult" @close="programAdditionResult = null" />
		<TransientToast v-if="message" :message="message" @close="message = ''" />
	</section>
</template>
