import { normalizeGenre, normalizeGenres } from './catalog-metadata.js';
import { XMLParser } from 'fast-xml-parser';
import {
	MAX_METADATA_LIST_ITEMS,
	MAX_METADATA_PEOPLE_ITEMS,
	MAX_METADATA_PLOT_LENGTH,
	MAX_METADATA_TEXT_LENGTH,
} from '@moirai/shared';
import { normalizedReleaseDate } from '../media/release-date.js';

/** Normalized metadata accepted from a bounded Kodi-style NFO sidecar. */
export interface ParsedNfo {
	title: string | null;
	sortTitle: string | null;
	plot: string | null;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	discNumber: number | null;
	uniqueId: string | null;
	externalIds: Array<{ provider: string; value: string; isDefault: boolean }>;
	primaryArtworkPaths: string[];
	genres: string[];
	directors: string[];
	actors: Array<{ name: string; role: string | null; sortOrder: number | null }>;
	metadata: Record<string, unknown>;
	truncatedFields: string[];
	invalidFields: string[];
}

/** Strict XML parser configured for the object shapes expected from Kodi NFO files. */
const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	trimValues: true,
});

/** Return the first scalar value from an XML field that may be repeated. */
function first(value: unknown): unknown {
	return Array.isArray(value) ? value[0] : value;
}

/** Extract scalar NFO text, ignoring structured or empty attributed elements. */
function rawStringValue(value: unknown): string | null {
	const selected = first(value);
	const text = selected && typeof selected === 'object'
		? (selected as Record<string, unknown>)['#text']
		: selected;

	return typeof text === 'string' || typeof text === 'number' || typeof text === 'boolean'
		? String(text)
		: null;
}

/** Truncate untrusted text to its documented storage or output limit. */
function boundedText(value: unknown, maximum = MAX_METADATA_TEXT_LENGTH): string | null {
	const text = rawStringValue(value)?.trim();
	return text ? text.slice(0, maximum) : null;
}

/** Parse a finite numeric NFO field or return no value. */
function numberValue(
	value: unknown,
	options: { minimum: number; maximum: number; integer?: boolean },
): number | null {
	const text = rawStringValue(value)?.trim();
	if (!text) {
		return null;
	}

	const parsed = Number(text);
	if (
		!Number.isFinite(parsed)
		|| parsed < options.minimum
		|| parsed > options.maximum
		|| (options.integer === true && !Number.isInteger(parsed))
	) {
		return null;
	}

	return parsed;
}

/** Resolve release year from the documented NFO date fields. */
function releaseYear(root: Record<string, unknown>): number | null {
	const explicit = numberValue(root.year, { minimum: 1, maximum: 9999, integer: true });
	if (explicit !== null) {
		return explicit;
	}

	for (const candidate of [root.premiered, root.releasedate, root.aired]) {
		const match = rawStringValue(candidate)?.match(/^(\d{4})/);
		if (match) {
			return Number(match[1]);
		}
	}
	return null;
}

/** Return the first valid full ISO release date exposed by common NFO aliases. */
function releaseDate(root: Record<string, unknown>): string | null {
	for (const candidate of [root.premiered, root.releasedate, root.aired]) {
		const normalized = normalizedReleaseDate(rawStringValue(candidate));
		if (normalized) {
			return normalized;
		}
	}

	return null;
}

/** Normalize one-or-many NFO values into bounded strings. */
function strings(value: unknown): string[] {
	if (value === undefined || value === null) {
		return [];
	}

	return (Array.isArray(value) ? value : [value])
		.map((entry) => boundedText(entry))
		.filter((item): item is string => Boolean(item));
}

/** Normalize NFO actor entries while preserving names, roles, and compatible billing order tags. */
function actors(
	value: unknown,
	parseOrder: (value: unknown) => number | null = (entry) => numberValue(entry, {
		minimum: 0,
		maximum: 999_999,
		integer: true,
	}),
): ParsedNfo['actors'] {
	const values
		= value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
	return values.flatMap((entry) => {
		if (!entry || typeof entry !== 'object') {
			return [];
		}

		const actor = entry as Record<string, unknown>;
		const name = boundedText(actor.name);
		if (!name) {
			return [];
		}

		return [{
			name,
			role: boundedText(actor.role),
			sortOrder: parseOrder(actor.order) ?? parseOrder(actor.sortorder),
		}];
	});
}

/** Return an object-like NFO value or an empty record. */
function recordValue(value: unknown): Record<string, unknown> | null {
	const selected = first(value);
	return selected && typeof selected === 'object' ? (selected as Record<string, unknown>) : null;
}

/** Deduplicate strings while preserving their first-seen order. */
function uniqueStrings(...values: unknown[]): string[] {
	const valuesByKey = new Map<string, string>();
	for (const value of values.flatMap(strings)) {
		const trimmed = value.trim();
		const key = trimmed.normalize('NFKC').toLocaleLowerCase('en-US');
		if (key && !valuesByKey.has(key)) {
			valuesByKey.set(key, trimmed);
		}
	}
	return [...valuesByKey.values()];
}

/** Parse provider-scoped and legacy provider-specific IDs without using them as structural identity. */
function externalIds(
	value: unknown,
	legacyValues: Record<string, unknown>,
): ParsedNfo['externalIds'] {
	const entries = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
	const ids = new Map<string, ParsedNfo['externalIds'][number]>();
	for (const entry of entries) {
		const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
		const rawValue = boundedText(record?.['#text'] ?? entry);
		if (!rawValue) {
			continue;
		}

		const provider = (boundedText(record?.['@_type']) ?? 'unknown').toLocaleLowerCase('en-US');
		const key = `${provider}:${rawValue.toLocaleLowerCase('en-US')}`;
		if (!ids.has(key)) {
			ids.set(key, {
				provider,
				value: rawValue,
				isDefault: String(record?.['@_default'] ?? '').toLowerCase() === 'true',
			});
		}
	}

	for (const [provider, providerValue] of Object.entries(legacyValues)) {
		const rawValue = boundedText(providerValue);
		if (!rawValue) {
			continue;
		}

		const key = `${provider}:${rawValue.toLocaleLowerCase('en-US')}`;
		if (!ids.has(key)) {
			ids.set(key, { provider, value: rawValue, isDefault: false });
		}
	}

	return [...ids.values()].slice(0, MAX_METADATA_LIST_ITEMS);
}

/** Read bounded local artwork references, preferring poster-qualified thumbnails. */
function primaryArtworkPaths(...values: unknown[]): string[] {
	const entries = values.flatMap((value) => {
		return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
	});
	return entries
		.map((entry) => {
			const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
			return {
				aspect: boundedText(record?.['@_aspect'])?.toLocaleLowerCase('en-US') ?? null,
				value: boundedText(record?.['#text'] ?? entry),
			};
		})
		.filter((entry): entry is { aspect: string | null; value: string } => Boolean(entry.value))
		.sort((left, right) => Number(right.aspect === 'poster') - Number(left.aspect === 'poster'))
		.slice(0, MAX_METADATA_LIST_ITEMS)
		.map((entry) => entry.value);
}

/** Select the default nested Kodi rating, falling back to the first valid named rating. */
function nestedRating(
	value: unknown,
	parseRating: (value: unknown) => number | null,
): number | null {
	const ratings = recordValue(value);
	const rawEntries = ratings?.rating;
	const entries = rawEntries === undefined || rawEntries === null
		? []
		: Array.isArray(rawEntries) ? rawEntries : [rawEntries];
	const ordered = [...entries].sort((left, right) => {
		const leftDefault = recordValue(left)?.['@_default'] === true
			|| String(recordValue(left)?.['@_default']).toLocaleLowerCase('en-US') === 'true';
		const rightDefault = recordValue(right)?.['@_default'] === true
			|| String(recordValue(right)?.['@_default']).toLocaleLowerCase('en-US') === 'true';
		return Number(rightDefault) - Number(leftDefault);
	});

	for (const entry of ordered) {
		const rating = parseRating(recordValue(entry)?.value);
		if (rating !== null) {
			return rating;
		}
	}

	return null;
}

/** Parse Kodi-style NFO XML into bounded presentation metadata and field diagnostics. */
export function parseKodiNfo(xml: string): ParsedNfo {
	// Locate a recognized metadata root while tolerating provider-specific wrappers.
	const parsed = parser.parse(xml) as Record<string, unknown>;
	const knownRoot = ['movie', 'episodedetails', 'tvshow', 'season', 'musicvideo', 'album']
		.map((name) => first(parsed[name]))
		.find((value) => value && typeof value === 'object');
	const fallbackRoot = Object.entries(parsed).find(
		([name, value]) => !name.startsWith('?') && value && typeof first(value) === 'object',
	)?.[1];
	const root = first(knownRoot ?? fallbackRoot) as Record<string, unknown> | undefined;
	if (!root || typeof root !== 'object') {
		throw new Error('NFO document has no metadata root');
	}

	const truncatedFields: string[] = [];
	const invalidFields: string[] = [];

	// Track invalid numeric fields instead of accepting values outside documented bounds.
	const checkedNumber = (
		name: string,
		value: unknown,
		options: { minimum: number; maximum: number; integer?: boolean },
	): number | null => {
		const result = numberValue(value, options);
		if (rawStringValue(value)?.trim() && result === null) {
			invalidFields.push(name);
		}
		return result;
	};
	const runtimeMinutes = checkedNumber('runtime', root.runtime, {
		minimum: 1,
		maximum: 525_600,
	});
	const explicitYear = checkedNumber('year', root.year, {
		minimum: 1,
		maximum: 9999,
		integer: true,
	});
	const year = explicitYear ?? releaseYear({ ...root, year: undefined });
	const exactReleaseDate = releaseDate(root);

	// Bound scalar and repeated presentation metadata before persistence.
	const limitedList = (name: string, values: string[]): string[] => {
		if (values.length > MAX_METADATA_LIST_ITEMS) {
			truncatedFields.push(name);
		}
		return values.slice(0, MAX_METADATA_LIST_ITEMS);
	};

	const limitedScalar = (name: string, value: unknown, maximum = MAX_METADATA_TEXT_LENGTH) => {
		const raw = rawStringValue(value)?.trim() ?? null;
		if (raw && raw.length > maximum) {
			truncatedFields.push(name);
		}
		return raw ? raw.slice(0, maximum) : null;
	};
	const genres = limitedList('genres', uniqueStrings(root.genre));

	// Honor Moirai primary markers without reordering the authored genre list.
	const genreKeys = new Set(normalizeGenres(genres).map((genre) => genre.key));
	const genreEntries = Array.isArray(root.genre) ? root.genre : [root.genre];
	const primaryGenre = genreEntries.find((entry) => {
		const value = boundedText(entry);
		return entry && typeof entry === 'object' && String(entry['@_primary']).toLowerCase() === 'true'
			&& value && genreKeys.has(normalizeGenre(value)?.key ?? '');
	});

	const limitedPeople = (name: string, values: string[]): string[] => {
		if (values.length > MAX_METADATA_PEOPLE_ITEMS) {
			truncatedFields.push(name);
		}
		return values.slice(0, MAX_METADATA_PEOPLE_ITEMS);
	};
	const directors = limitedPeople('directors', uniqueStrings(root.director));
	const allCast = actors(root.actor, (value) => checkedNumber('actorOrder', value, {
		minimum: 0,
		maximum: 999_999,
		integer: true,
	}));
	const cast = allCast.slice(0, MAX_METADATA_PEOPLE_ITEMS);
	if (allCast.length > MAX_METADATA_PEOPLE_ITEMS) {
		truncatedFields.push('actors');
	}
	const writers = uniqueStrings(root.credits, root.writer);
	const countries = uniqueStrings(root.country);
	const streamDetails = recordValue(recordValue(root.fileinfo)?.streamdetails);
	const video = recordValue(streamDetails?.video);
	const width = checkedNumber('width', video?.width, { minimum: 1, maximum: 65_535, integer: true });
	const height = checkedNumber('height', video?.height, { minimum: 1, maximum: 65_535, integer: true });
	const resolution
		= width !== null && width > 0 && height !== null && height > 0 ? { width, height } : null;
	const ratingOptions = { minimum: 0, maximum: 10 };
	const rating = checkedNumber('rating', root.rating, ratingOptions)
		?? nestedRating(root.ratings, (value) => checkedNumber('rating', value, ratingOptions));
	const art = recordValue(root.art);

	// Separate common display fields from optional provider metadata and diagnostics.
	return {
		title: limitedScalar('title', root.title)
			?? limitedScalar('localTitle', root.localtitle)
			?? limitedScalar('name', root.name),
		sortTitle: limitedScalar('sortTitle', root.sorttitle)
			?? limitedScalar('sortName', root.sortname),
		plot: limitedScalar('plot', root.plot, MAX_METADATA_PLOT_LENGTH)
			?? limitedScalar('outline', root.outline, MAX_METADATA_PLOT_LENGTH),
		year,
		seasonNumber: checkedNumber('season', root.season, { minimum: 0, maximum: 9999, integer: true }),
		episodeNumber: checkedNumber('episode', root.episode, { minimum: 0, maximum: 999_999, integer: true }),
		discNumber: checkedNumber('disc', root.disc ?? root.discnumber, {
			minimum: 0,
			maximum: 9999,
			integer: true,
		}),
		uniqueId: limitedScalar('uniqueId', root.uniqueid),
		externalIds: externalIds(root.uniqueid, {
			imdb: root.imdbid,
			tmdb: root.tmdbid,
			tvdb: root.tvdbid,
		}),
		primaryArtworkPaths: primaryArtworkPaths(root.thumb, art?.poster),
		genres,
		directors,
		actors: cast,
		metadata: {
			reportedRuntimeMinutes: runtimeMinutes,
			originalTitle: limitedScalar('originalTitle', root.originaltitle),
			releaseDate: exactReleaseDate,
			premiered: limitedScalar('premiered', root.premiered),
			aired: limitedScalar('aired', root.aired),
			rating,
			userRating: checkedNumber('userRating', root.userrating, ratingOptions),
			certification: limitedScalar('certification', root.mpaa),
			studio: limitedList('studio', uniqueStrings(root.studio)),
			writers: limitedPeople('writers', writers),
			countries: limitedList('countries', countries),
			resolution,
			genres,
			...(primaryGenre ? { primaryGenre: boundedText(primaryGenre) } : {}),
			directors,
			actors: cast,
			tags: limitedList('tags', uniqueStrings(root.tag)),
			artists: limitedPeople('artists', uniqueStrings(root.artist)),
			album: limitedScalar('album', root.album),
			track: checkedNumber('track', root.track, { minimum: 0, maximum: 999_999, integer: true }),
		},
		truncatedFields,
		invalidFields,
	};
}
