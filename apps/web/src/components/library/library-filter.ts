import type {
	CatalogProgramItemFilter,
	CatalogProgramItemQuery,
	GenreMatch,
} from '@moirai/shared';
import type { MediaQuery } from '../../api';
import { durationFilterDraft, durationFilterSeconds, durationFilterLabel, type DurationFilterDraft } from './duration-filter';

/** Editable catalog filters retained privately until the user applies them. */
export interface LibraryFilterDraft {
	name: string;
	artist?: string;
	album?: string;
	releaseFrom: string;
	releaseTo: string;
	minimumDuration: DurationFilterDraft;
	maximumDuration: DurationFilterDraft;
	minimumRating: string;
	minimumUserRating: string;
	addedFrom: string;
	addedTo: string;
	genres: string[];
	primaryGenres: string[];
	excludedGenres: string[];
	genreMatch: GenreMatch;
	actor: string;
	director: string;
}

/** Show genre totals exactly below 1,000, otherwise as thousands rounded to the nearest hundred. */
export function genreCountLabel(count: number | null): string {
	if (count === null) {
		return '—';
	}

	return count < 1000 ? String(count) : `${(Math.round(count / 100) / 10).toFixed(1)}k`;
}

/** Create an independent empty filter draft with the default Match all genre behavior. */
export function emptyLibraryFilterDraft(): LibraryFilterDraft {
	return {
		name: '',
		artist: '',
		album: '',
		releaseFrom: '',
		releaseTo: '',
		minimumDuration: durationFilterDraft(null),
		maximumDuration: durationFilterDraft(null),
		minimumRating: '',
		minimumUserRating: '',
		addedFrom: '',
		addedTo: '',
		genres: [],
		primaryGenres: [],
		excludedGenres: [],
		genreMatch: 'all',
		actor: '',
		director: '',
	};
}

/** Create the persisted empty filter shared by dynamic programs and Quick Setup. */
export function emptyCatalogProgramItemFilter(): CatalogProgramItemFilter {
	return {
		name: '',
		releaseYearFrom: null,
		releaseYearTo: null,
		minimumDurationSeconds: null,
		maximumDurationSeconds: null,
		minimumRating: null,
		minimumUserRating: null,
		addedFrom: null,
		addedBefore: null,
		genres: [],
		primaryGenres: [],
		excludedGenres: [],
		genreMatch: 'all',
		actor: '',
		director: '',
	};
}

/** Keep authored filter text readable without allowing one value to dominate the summary. */
function compactFilterValue(value: string, maximumLength = 28): string {
	return value.length > maximumLength ? `${value.slice(0, maximumLength - 1)}…` : value;
}

/** Describe an optional inclusive range in one compact label. */
function compactFilterRange(
	label: string,
	from: string | number | null,
	to: string | number | null,
): string | null {
	if (from !== null && to !== null) {
		return `${label}: ${from}–${to}`;
	}
	if (from !== null) {
		return `${label}: ${from}+`;
	}
	if (to !== null) {
		return `${label}: through ${to}`;
	}

	return null;
}

/** Build prioritized, scan-friendly labels for an applied dynamic-library filter. */
export function catalogProgramItemFilterSummary(
	filter: CatalogProgramItemFilter,
	genreNames: ReadonlyMap<string, string> = new Map(),
): string[] {
	const labels: string[] = [];
	const genres = (keys: string[]) => keys.map((key) => genreNames.get(key) ?? key);
	const genreList = (keys: string[]) => {
		const names = genres(keys);
		return `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`;
	};
	const releaseYears = compactFilterRange(
		'Years',
		filter.releaseYearFrom,
		filter.releaseYearTo,
	);
	const addedDates = libraryFilterDraft(filter);
	const added = compactFilterRange('Added', addedDates.addedFrom || null, addedDates.addedTo || null);

	if (filter.name) {
		labels.push(`Title: ${compactFilterValue(filter.name)}`);
	}
	if (filter.primaryGenres.length > 0) {
		labels.push(`Primary (${filter.genreMatch}): ${genreList(filter.primaryGenres)}`);
	}
	if (filter.genres.length > 0) {
		labels.push(`${filter.genreMatch === 'any' ? 'Any genre' : 'All genres'}: ${genreList(filter.genres)}`);
	}
	if (filter.excludedGenres.length > 0) {
		labels.push(`Exclude: ${genreList(filter.excludedGenres)}`);
	}
	if (releaseYears) {
		labels.push(releaseYears);
	}
	const duration = compactFilterRange(
		'Duration',
		filter.minimumDurationSeconds == null ? null : durationFilterLabel(filter.minimumDurationSeconds),
		filter.maximumDurationSeconds == null ? null : durationFilterLabel(filter.maximumDurationSeconds),
	);
	if (duration) {
		labels.push(duration);
	}
	if (filter.minimumRating !== null) {
		labels.push(`Rating: ${filter.minimumRating}+`);
	}
	if (filter.minimumUserRating !== null) {
		labels.push(`User rating: ${filter.minimumUserRating}+`);
	}
	if (filter.artist) {
		labels.push(`Artist: ${compactFilterValue(filter.artist)}`);
	}
	if (filter.album) {
		labels.push(`Album: ${compactFilterValue(filter.album)}`);
	}
	if (filter.actor) {
		labels.push(`Actor: ${compactFilterValue(filter.actor)}`);
	}
	if (filter.director) {
		labels.push(`Director: ${compactFilterValue(filter.director)}`);
	}
	if (added) {
		labels.push(added);
	}

	return labels;
}

/** Format a persisted instant as the local calendar date represented by a filter control. */
function localDateValue(value: string | null, end = false): string {
	if (!value) {
		return '';
	}

	const date = new Date(value);
	if (end) {
		date.setDate(date.getDate() - 1);
	}
	const year = String(date.getFullYear());
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/** Convert one local date input into an inclusive-start or exclusive-end instant. */
function localDateInstant(value: string, end = false): string | null {
	if (!value) {
		return null;
	}

	const [year, month, day] = value.split('-').map(Number);
	return new Date(year!, month! - 1, day! + (end ? 1 : 0)).toISOString();
}

/** Build an independently editable Filter Library draft from persisted program filters. */
export function libraryFilterDraft(filter: CatalogProgramItemFilter): LibraryFilterDraft {
	return {
		name: filter.name,
		artist: filter.artist ?? '',
		album: filter.album ?? '',
		releaseFrom: filter.releaseYearFrom === null ? '' : String(filter.releaseYearFrom),
		releaseTo: filter.releaseYearTo === null ? '' : String(filter.releaseYearTo),
		minimumDuration: durationFilterDraft(filter.minimumDurationSeconds),
		maximumDuration: durationFilterDraft(filter.maximumDurationSeconds),
		minimumRating: filter.minimumRating === null ? '' : String(filter.minimumRating),
		minimumUserRating: filter.minimumUserRating === null ? '' : String(filter.minimumUserRating),
		addedFrom: localDateValue(filter.addedFrom),
		addedTo: localDateValue(filter.addedBefore, true),
		genres: [...filter.genres],
		primaryGenres: [...filter.primaryGenres],
		excludedGenres: [...filter.excludedGenres],
		genreMatch: filter.genreMatch,
		actor: filter.actor,
		director: filter.director,
	};
}

/** Convert the Filter Library controls into the persisted dynamic-program filter contract. */
export function catalogProgramItemFilter(
	draft: LibraryFilterDraft,
): CatalogProgramItemFilter {
	return {
		name: draft.name.trim(),
		...(draft.artist?.trim() ? { artist: draft.artist.trim() } : {}),
		...(draft.album?.trim() ? { album: draft.album.trim() } : {}),
		releaseYearFrom: draft.releaseFrom ? Number(draft.releaseFrom) : null,
		releaseYearTo: draft.releaseTo ? Number(draft.releaseTo) : null,
		minimumDurationSeconds: durationFilterSeconds(draft.minimumDuration),
		maximumDurationSeconds: durationFilterSeconds(draft.maximumDuration),
		minimumRating: draft.minimumRating ? Number(draft.minimumRating) : null,
		minimumUserRating: draft.minimumUserRating ? Number(draft.minimumUserRating) : null,
		addedFrom: localDateInstant(draft.addedFrom),
		addedBefore: localDateInstant(draft.addedTo, true),
		genres: [...draft.genres],
		primaryGenres: [...draft.primaryGenres],
		excludedGenres: draft.genreMatch === 'all' ? [...draft.excludedGenres] : [],
		genreMatch: draft.genreMatch,
		actor: draft.actor.trim(),
		director: draft.director.trim(),
	};
}

/** Convert current catalog filters into the persisted recursive program-selection contract. */
export function catalogProgramQuery(query: MediaQuery): CatalogProgramItemQuery {
	return {
		parentId: query.parentId ?? null,
		sort: query.sort,
		direction: query.direction,
		name: query.name ?? '',
		...(query.search ? { search: query.search } : {}),
		...(query.artist ? { artist: query.artist } : {}),
		...(query.album ? { album: query.album } : {}),
		releaseYearFrom: query.releaseYearFrom ?? null,
		releaseYearTo: query.releaseYearTo ?? null,
		minimumDurationSeconds: query.minimumDurationSeconds ?? null,
		maximumDurationSeconds: query.maximumDurationSeconds ?? null,
		minimumRating: query.minimumRating ?? null,
		minimumUserRating: query.minimumUserRating ?? null,
		addedFrom: query.addedFrom ?? null,
		addedBefore: query.addedBefore ?? null,
		genres: query.genres ?? [],
		primaryGenres: query.primaryGenres ?? [],
		excludedGenres: query.excludedGenres ?? [],
		genreMatch: query.genreMatch ?? 'all',
		actor: query.actor ?? '',
		director: query.director ?? '',
	};
}
