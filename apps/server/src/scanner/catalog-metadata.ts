export { catalogSortTitle } from '@moirai/shared';

/** Version used to invalidate indexed metadata when normalization behavior changes. */
export const ON_DISK_METADATA_VERSION = 11;

/** Canonical genre key paired with its preferred display name. */
export interface NormalizedGenre {
	key: string;
	name: string;
}

/** Person credit stored in the normalized catalog index. */
export interface NormalizedPerson {
	personType: 'actor' | 'director';
	name: string;
	normalizedName: string;
	role: string | null;
	sortOrder: number | null;
}

/** Fold user-facing metadata into a stable value suitable for indexed matching. */
export function normalizeSearchText(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/\p{Diacritic}/gu, '')
		.trim()
		.replace(/\s+/g, ' ')
		.toLocaleLowerCase('en-US');
}

/** Return the A–Z browse bucket for a normalized title. */
export function titleBucket(value: string): string {
	const first = normalizeSearchText(value).charAt(0).toUpperCase();
	return /^[A-Z]$/.test(first) ? first : '#';
}

/** Common genre spellings collapsed into stable browse facets. */
const GENRE_ALIASES = new Map<string, NormalizedGenre>([
	['sci fi', { key: 'science-fiction', name: 'Science Fiction' }],
	['scifi', { key: 'science-fiction', name: 'Science Fiction' }],
	['science fiction', { key: 'science-fiction', name: 'Science Fiction' }],
	['rom com', { key: 'romantic-comedy', name: 'Romantic Comedy' }],
	['romcom', { key: 'romantic-comedy', name: 'Romantic Comedy' }],
	['romantic comedy', { key: 'romantic-comedy', name: 'Romantic Comedy' }],
	['tv movie', { key: 'tv-movie', name: 'TV Movie' }],
	['tvmovie', { key: 'tv-movie', name: 'TV Movie' }],
	['television movie', { key: 'tv-movie', name: 'TV Movie' }],
	['reality tv', { key: 'reality-tv', name: 'Reality TV' }],
	['reality television', { key: 'reality-tv', name: 'Reality TV' }],
	['game show', { key: 'game-show', name: 'Game Show' }],
	['gameshow', { key: 'game-show', name: 'Game Show' }],
	['talk show', { key: 'talk-show', name: 'Talk Show' }],
	['talkshow', { key: 'talk-show', name: 'Talk Show' }],
	['soap opera', { key: 'soap-opera', name: 'Soap Opera' }],
	['soapopera', { key: 'soap-opera', name: 'Soap Opera' }],
	['docu series', { key: 'docuseries', name: 'Docuseries' }],
	['docuseries', { key: 'docuseries', name: 'Docuseries' }],
	['film noir', { key: 'film-noir', name: 'Film Noir' }],
]);

/** Canonicalize common genre aliases while retaining a readable facet label. */
export function normalizeGenre(value: string): NormalizedGenre | null {
	const normalized = normalizeSearchText(value)
		.replace(/[-_/]+/g, ' ')
		.replace(/\s+/g, ' ');
	if (!normalized) {
		return null;
	}

	const alias = GENRE_ALIASES.get(normalized);
	if (alias) {
		return alias;
	}

	const key = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
	if (!key) {
		return null;
	}

	return {
		key,
		name: normalized.replace(/\b\w/g, (letter) => letter.toUpperCase()),
	};
}

/** Deduplicate and canonicalize a list of source genre values. */
export function normalizeGenres(values: string[]): NormalizedGenre[] {
	const genres = new Map<string, NormalizedGenre>();
	for (const value of values) {
		const genre = normalizeGenre(value);
		if (genre) {
			genres.set(genre.key, genre);
		}
	}
	return [...genres.values()];
}

/**
 * Normalize and deduplicate NFO credits by the catalog's persisted identity.
 * Duplicate actor entries retain the first name, the first useful role, and
 * the earliest declared cast order.
 */
export function normalizePeople(
	directors: string[],
	actors: Array<{ name: string; role: string | null; sortOrder: number | null }>,
): NormalizedPerson[] {
	const people = new Map<string, NormalizedPerson>();
	const add = (person: Omit<NormalizedPerson, 'normalizedName'>): void => {
		const normalizedName = normalizeSearchText(person.name);
		if (!normalizedName) {
			return;
		}

		const key = `${person.personType}:${normalizedName}`;
		const existing = people.get(key);
		if (!existing) {
			people.set(key, { ...person, normalizedName });
			return;
		}

		if (!existing.role && person.role) {
			existing.role = person.role;
		}
		if (
			person.sortOrder !== null
			&& (existing.sortOrder === null || person.sortOrder < existing.sortOrder)
		) {
			existing.sortOrder = person.sortOrder;
		}
	};
	for (const name of directors) {
		add({ personType: 'director', name, role: null, sortOrder: null });
	}
	for (const actor of actors) {
		add({ personType: 'actor', ...actor });
	}
	return [...people.values()];
}
