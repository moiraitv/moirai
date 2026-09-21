import type {
	LibraryQuerySort,
	ProgramConfig,
	SchedulableMedia,
} from '@moirai/shared';
import { musicTextMatches } from '../media/music-search.js';
import { normalizeSearchText } from '../scanner/catalog-metadata.js';

/** Persisted dynamic library-query source accepted by content programs. */
type LibraryQuerySource = Extract<
	Extract<ProgramConfig, { type: 'content' }>['source'],
	{ type: 'library-query' }
>;

/** Omit behavior-neutral query defaults so saved legacy playback identities remain stable. */
export function libraryQueryStateSource(source: LibraryQuerySource): Record<string, unknown> {
	return Object.fromEntries(Object.entries(source).filter(([key, value]) => {
		if (value == null || value === '') {
			return false;
		}
		if (key === 'excludedGenres' && Array.isArray(value) && value.length === 0) {
			return false;
		}
		if (key === 'genreMatch' && value === 'all') {
			return false;
		}
		if (key === 'sort' && source.sort?.type === 'name' && source.sort.direction === 'asc') {
			return false;
		}
		return true;
	}));
}

/** Read one normalized person name from the scheduling catalog's compact metadata projection. */
function personMatches(names: string[] | undefined, query: string): boolean {
	if (!query) {
		return true;
	}

	const normalizedQuery = normalizeSearchText(query);
	return (names ?? []).some((name) => normalizeSearchText(name).includes(normalizedQuery));
}

/** Apply the shared Filter Library semantics to one dynamic scheduling candidate. */
export function mediaMatchesLibraryQuery(
	media: SchedulableMedia,
	source: LibraryQuerySource,
): boolean {
	if (media.libraryId !== source.libraryId) {
		return false;
	}
	if (source.kinds.length > 0 && !source.kinds.includes(media.kind)) {
		return false;
	}
	if (
		!source.name
		&& source.releaseYearFrom == null
		&& source.releaseYearTo == null
		&& source.minimumDurationSeconds == null
		&& source.maximumDurationSeconds == null
		&& source.minimumRating == null
		&& source.minimumUserRating == null
		&& !source.addedFrom
		&& !source.addedBefore
		&& source.genres.length === 0
		&& (source.excludedGenres ?? []).length === 0
		&& !source.actor
		&& !source.director
		&& !source.artist
		&& !source.album
	) {
		return true;
	}
	for (const [query, labels] of [[source.artist, media.artistNames ?? media.artists], [source.album, media.albumNames]] as const) {
		if (query && !(labels ?? []).some(label => musicTextMatches(label, query))) {
			return false;
		}
	}
	if (source.name && !media.title.toLocaleLowerCase().includes(source.name.toLocaleLowerCase())) {
		return false;
	}
	if (source.releaseYearFrom != null && (media.year ?? -Infinity) < source.releaseYearFrom) {
		return false;
	}
	if (source.releaseYearTo != null && (media.year ?? Infinity) > source.releaseYearTo) {
		return false;
	}
	if (source.minimumDurationSeconds != null
		&& (media.durationSeconds == null || media.durationSeconds < source.minimumDurationSeconds)) {
		return false;
	}
	if (source.maximumDurationSeconds != null
		&& (media.durationSeconds == null || media.durationSeconds > source.maximumDurationSeconds)) {
		return false;
	}
	if (source.minimumRating != null && (media.rating ?? -Infinity) < source.minimumRating) {
		return false;
	}
	if (
		source.minimumUserRating != null
		&& (media.userRating ?? -Infinity) < source.minimumUserRating
	) {
		return false;
	}
	if (source.addedFrom && (!media.dateAddedAt
		|| Date.parse(media.dateAddedAt) < Date.parse(source.addedFrom))) {
		return false;
	}
	if (source.addedBefore && (!media.dateAddedAt
		|| Date.parse(media.dateAddedAt) >= Date.parse(source.addedBefore))) {
		return false;
	}
	if (
		source.genres.length > 0
		&& ((source.genreMatch ?? 'all') === 'all'
			? !source.genres.every((genre) => media.genres.includes(genre))
			: !source.genres.some((genre) => media.genres.includes(genre)))
	) {
		return false;
	}
	if ((source.excludedGenres ?? []).some((genre) => media.genres.includes(genre))) {
		return false;
	}
	if (!personMatches(media.actors, source.actor ?? '')) {
		return false;
	}
	if (!personMatches(media.directors, source.director ?? '')) {
		return false;
	}

	return true;
}

/** Compare media using the stable episode and title ordering used by sequential playback. */
export function compareSchedulingMedia(a: SchedulableMedia, b: SchedulableMedia): number {
	const season
		= (a.seasonNumber ?? Number.MAX_SAFE_INTEGER) - (b.seasonNumber ?? Number.MAX_SAFE_INTEGER);
	if (season !== 0) {
		return season;
	}

	const episode
		= (a.episodeNumber ?? Number.MAX_SAFE_INTEGER) - (b.episodeNumber ?? Number.MAX_SAFE_INTEGER);
	if (episode !== 0) {
		return episode;
	}

	const group = (a.groupSortKey ?? '').localeCompare(b.groupSortKey ?? '', undefined, {
		sensitivity: 'base',
	});
	if (group !== 0) {
		return group;
	}

	const disc = (a.discNumber ?? 1) - (b.discNumber ?? 1);
	if (disc !== 0) {
		return disc;
	}

	const track
		= (a.trackNumber ?? Number.MAX_SAFE_INTEGER) - (b.trackNumber ?? Number.MAX_SAFE_INTEGER);
	if (track !== 0) {
		return track;
	}

	return (
		a.sortTitle.localeCompare(b.sortTitle, undefined, { sensitivity: 'base' })
		|| a.id.localeCompare(b.id)
	);
}

/** Compare optional dates while keeping missing metadata at the end in either direction. */
function compareOptionalDates(
	left: string | null | undefined,
	right: string | null | undefined,
	direction: LibraryQuerySort['direction'],
): number {
	if (!left || !right) {
		return left === right ? 0 : left ? -1 : 1;
	}

	return left.localeCompare(right) * (direction === 'asc' ? 1 : -1);
}

/** Order dynamic query matches for previews and sequential playback. */
export function compareLibraryQueryMedia(
	a: SchedulableMedia,
	b: SchedulableMedia,
	sort: LibraryQuerySort = { type: 'name', direction: 'asc' },
): number {
	if (sort.type === 'date-added') {
		return compareOptionalDates(a.dateAddedAt, b.dateAddedAt, sort.direction)
			|| compareSchedulingMedia(a, b);
	}
	if (sort.type === 'release-date') {
		const left = a.releaseDate ?? (a.year === null ? null : `${a.year}-01-01`);
		const right = b.releaseDate ?? (b.year === null ? null : `${b.year}-01-01`);
		return compareOptionalDates(left, right, sort.direction) || compareSchedulingMedia(a, b);
	}

	const compared = compareSchedulingMedia(a, b);
	return sort.direction === 'asc' ? compared : -compared;
}
