import type {
	CatalogProgramItemFilter,
	Library,
	LibraryQuerySort,
	MediaGroup,
	MediaItem,
	QuickChannelScenario,
	QuickChannelSetupCreate,
	SelectionStrategy,
} from '@moirai/shared';
import { canonicalIdentityKey } from '@moirai/shared';

/** Mutable programming choices retained while navigating the wizard. */
export interface QuickProgrammingDraft {
	name: string;
	sourceType: 'library-query' | 'collection' | 'group-collection';
	filter: CatalogProgramItemFilter;
	querySort: LibraryQuerySort;
	queryItemLimit: number | null;
	items: MediaItem[];
	groups: MediaGroup[];
	strategy: SelectionStrategy['type'];
	seed: string;
}

/** Mutable channel presentation choices retained while navigating the wizard. */
export interface QuickChannelDraft {
	number: string;
	name: string;
	group: string;
}

/** Presentation and authored defaults for one Quick Setup scenario. */
export interface QuickScenarioPreset {
	id: QuickChannelScenario;
	title: string;
	description: string;
	channelName: string;
	programName: string;
	libraryName: string;
	group: string;
	strategy: SelectionStrategy['type'];
}

/** Supported Quick Setup scenarios in their display order. */
export const QUICK_SCENARIOS: readonly QuickScenarioPreset[] = [
	{
		id: 'movies',
		title: 'Movie Channel',
		description: 'Build a movie channel from selected items or dynamically choose based on genre or other attributes.',
		channelName: 'Movie Channel',
		programName: 'Movie Programming',
		libraryName: 'Movies',
		group: 'Movies',
		strategy: 'shuffle',
	},
	{
		id: 'shows',
		title: 'Show Channel',
		description: 'Play episodes in order from a library, show, or season selection.',
		channelName: 'Show Channel',
		programName: 'Show Programming',
		libraryName: 'Shows',
		group: 'Shows',
		strategy: 'sequential',
	},
	{
		id: 'music-videos',
		title: 'Music Video Channel',
		description: 'Shuffle music videos without repeats until the full set has played.',
		channelName: 'Music Video Channel',
		programName: 'Music Video Programming',
		libraryName: 'Music Videos',
		group: 'Music Videos',
		strategy: 'shuffle',
	},
];

/** Return the configured preset for a scenario. */
export function quickScenarioPreset(scenario: QuickChannelScenario): QuickScenarioPreset {
	return QUICK_SCENARIOS.find((preset) => preset.id === scenario)!;
}

/** Return libraries whose built-in type matches the chosen setup scenario. */
export function compatibleQuickLibraries(
	libraries: Library[],
	scenario: QuickChannelScenario,
): Library[] {
	return libraries.filter((library) => library.typeKey === scenario);
}

/** Suggest the first positive integer not already used as a channel number. */
export function suggestedQuickChannelNumber(numbers: string[]): string {
	const used = new Set(numbers);
	let candidate = 1;
	while (used.has(String(candidate))) {
		candidate += 1;
	}
	return String(candidate);
}

/** Build the strategy contract accepted by Quick Setup persistence. */
export function quickSelectionStrategy(
	strategy: SelectionStrategy['type'],
	seed = '',
): SelectionStrategy {
	return strategy === 'sequential' ? { type: strategy } : { type: strategy, seed };
}

/** Build the review-visible generated daily template name before server collision suffixing. */
export function quickTemplateName(channelName: string): string {
	const ending = ' Daily';
	return `${channelName.trim().slice(0, 120 - ending.length).trimEnd()}${ending}`;
}

/** Preview the same readable numeric suffix used by server-side template creation. */
export function suggestedQuickTemplateName(channelName: string, templateNames: string[]): string {
	const base = quickTemplateName(channelName);
	const used = new Set(templateNames.map(canonicalIdentityKey));
	let suffix = 1;
	while (true) {
		const ending = suffix === 1 ? ' Daily' : ` Daily (${suffix})`;
		const candidate = suffix === 1
			? base
			: `${channelName.trim().slice(0, 120 - ending.length).trimEnd()}${ending}`;
		if (!used.has(canonicalIdentityKey(candidate))) {
			return candidate;
		}
		suffix += 1;
	}
}

/** Describe one request source for the final review. */
export function quickSourceSummary(source: QuickChannelSetupCreate['source']): string {
	if (source.type === 'library-query') {
		const filterCount = [
			source.name,
			source.releaseYearFrom,
			source.releaseYearTo,
			source.minimumRating,
			source.minimumUserRating,
			source.addedFrom,
			source.addedBefore,
			...source.genres,
			...source.excludedGenres,
			source.actor,
			source.director,
		].filter((value) => value !== '' && value !== null).length;
		const order = source.sort.type === 'name'
			? 'Title / episode'
			: source.sort.type === 'date-added' ? 'Date indexed' : 'Release date';
		const ordering = `${order}, ${source.sort.direction === 'asc' ? 'ascending' : 'descending'}`;
		const limit = source.itemLimit === null
			? 'All matches'
			: `First ${source.itemLimit.toLocaleString()}`;
		const selection = filterCount > 0
			? `Library query · ${filterCount.toLocaleString()} active ${filterCount === 1 ? 'filter' : 'filters'}`
			: 'Entire compatible library';
		return `${selection} · ${ordering} · ${limit}`;
	}
	if (source.type === 'group-collection') {
		return `${source.groupIds.length.toLocaleString()} selected ${source.groupIds.length === 1 ? 'show or season' : 'shows or seasons'}`;
	}
	return `${source.itemIds.length.toLocaleString()} selected ${source.itemIds.length === 1 ? 'item' : 'items'}`;
}
