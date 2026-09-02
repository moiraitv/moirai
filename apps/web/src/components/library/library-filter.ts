import type { CatalogProgramItemQuery, GenreMatch } from '@moirai/shared';
import type { MediaQuery } from '../../api';

/** Editable catalog filters retained privately until the user applies them. */
export interface LibraryFilterDraft {
	name: string;
	releaseFrom: string;
	releaseTo: string;
	minimumRating: string;
	minimumUserRating: string;
	addedFrom: string;
	addedTo: string;
	genres: string[];
	excludedGenres: string[];
	genreMatch: GenreMatch;
	actor: string;
	director: string;
}

/** Create an independent empty filter draft with the default Match all genre behavior. */
export function emptyLibraryFilterDraft(): LibraryFilterDraft {
	return {
		name: '',
		releaseFrom: '',
		releaseTo: '',
		minimumRating: '',
		minimumUserRating: '',
		addedFrom: '',
		addedTo: '',
		genres: [],
		excludedGenres: [],
		genreMatch: 'all',
		actor: '',
		director: '',
	};
}

/** Convert current catalog filters into the persisted recursive program-selection contract. */
export function catalogProgramQuery(query: MediaQuery): CatalogProgramItemQuery {
	return {
		parentId: query.parentId ?? null,
		sort: query.sort,
		direction: query.direction,
		name: query.name ?? '',
		releaseYearFrom: query.releaseYearFrom ?? null,
		releaseYearTo: query.releaseYearTo ?? null,
		minimumRating: query.minimumRating ?? null,
		minimumUserRating: query.minimumUserRating ?? null,
		addedFrom: query.addedFrom ?? null,
		addedBefore: query.addedBefore ?? null,
		genres: query.genres ?? [],
		excludedGenres: query.excludedGenres ?? [],
		genreMatch: query.genreMatch ?? 'all',
		actor: query.actor ?? '',
		director: query.director ?? '',
	};
}
