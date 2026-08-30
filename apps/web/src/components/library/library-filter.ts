import type { GenreMatch } from '@moirai/shared';

/** Editable catalog filters retained privately until the user applies them. */
export interface LibraryFilterDraft {
	name: string;
	releaseFrom: string;
	releaseTo: string;
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
		addedFrom: '',
		addedTo: '',
		genres: [],
		excludedGenres: [],
		genreMatch: 'all',
		actor: '',
		director: '',
	};
}
