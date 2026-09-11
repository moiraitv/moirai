import path from 'node:path';
import type { MediaExternalId, MediaPart } from '@moirai/shared';

/** Structured metadata derived conservatively from one portable video filename. */
export interface ParsedVideoFilename {
	title: string;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	episodeEndNumber: number | null;
	edition: string | null;
	externalIds: MediaExternalId[];
	trackNumber: number | null;
	discNumber: number | null;
	part: Pick<MediaPart, 'number' | 'kind'> | null;
	logicalStem: string;
}

/** Show-folder identity parsed separately from episode filenames. */
export interface ParsedCollectionFolder {
	title: string;
	year: number | null;
	externalIds: MediaExternalId[];
}

/** Collapse portable separator styles without damaging authored spaced dashes. */
function readable(value: string): string {
	// Transforms "Show.Name__Pilot" to "Show Name Pilot".
	const separated = value.replace(/[._]+/g, ' ');
	// Transforms "Show   Name" to "Show Name".
	const normalized = separated.replace(/\s+/g, ' ').trim();
	if (!normalized.includes(' ') && normalized.includes('-')) {
		// Transforms the separator-only title "Captain-America" to "Captain America".
		const dehyphenated = normalized.replace(/-+/g, ' ');
		// Transforms any spacing exposed by repeated hyphens to a single space.
		return dehyphenated.replace(/\s+/g, ' ').trim();
	}

	// Transforms "- Show Name -" to "Show Name" while preserving an internal spaced dash.
	return normalized.replace(/^[-\s]+|[-\s]+$/g, '').trim();
}

/** Parse and remove portable provider and edition brace tags. */
function braceTags(value: string): {
	value: string;
	edition: string | null;
	externalIds: MediaExternalId[];
} {
	let edition: string | null = null;
	const externalIds: MediaExternalId[] = [];
	// Matches tags such as "{tmdb-603}" or "{edition-Director's Cut}" for extraction.
	const cleaned = value.replace(/\{([a-z][a-z0-9._-]*)-([^{}]+)\}/gi, (match, rawProvider, rawValue) => {
		const provider = String(rawProvider).toLocaleLowerCase('en-US');
		const id = String(rawValue).trim();
		if (provider === 'edition') {
			edition ??= id;
		}
		else if (id) {
			externalIds.push({ provider, value: id, isDefault: externalIds.length === 0 });
		}
		return ' ';
	});
	return { value: cleaned, edition, externalIds };
}

/** Parse a terminal multipart suffix only when it follows a nonempty name prefix. */
function multipart(value: string): {
	logicalStem: string;
	part: ParsedVideoFilename['part'];
} {
	// Matches multipart suffixes such as "Movie Name-disc2" or "Movie Name - Part 2".
	const match = value.match(/^(.*?)(?:\s+-\s+|[._-])?(disc|part|cd|dvd|disk)[ ._-]*(\d{1,3})$/i);
	if (!match) {
		return { logicalStem: value, part: null };
	}

	// Transforms a captured stem such as "Movie Name - " to "Movie Name".
	const logicalStem = match[1]!.replace(/[ ._-]+$/g, '');
	if (!readable(logicalStem)) {
		return { logicalStem: value, part: null };
	}

	return {
		logicalStem,
		part: {
			kind: match[2]!.toLocaleLowerCase('en-US') as NonNullable<MediaPart['kind']>,
			number: Number(match[3]),
		},
	};
}

/** Remove one terminal release year while retaining it as structured metadata. */
function releaseYear(value: string): { value: string; year: number | null } {
	// Matches a standalone parenthesized year in "Movie Name (1999) {tmdb-603}".
	const parenthesized = value.match(/(?:^|\s)\(((?:18|19|20|21)\d{2})\)(?:\s|$)/);
	if (parenthesized) {
		return {
			value: value.replace(parenthesized[0], ' '),
			year: Number(parenthesized[1]),
		};
	}

	// Matches an unparenthesized terminal year in "Movie Name.1999".
	const terminal = value.match(/^(.*?)[ ._-]+((?:18|19|20|21)\d{2})$/);
	return terminal
		? { value: terminal[1]!, year: Number(terminal[2]) }
		: { value, year: null };
}

/** Recognize legacy movie edition suffixes shown in the portable naming guide. */
function legacyEdition(value: string): { value: string; edition: string | null } {
	// Matches "Movie Name - Director's Cut" as title "Movie Name" plus its edition.
	const match = value.match(
		/^(.*?)\s+-\s+(1080p|720p|4k|extended edition|director(?:['’]?s)? cut|3d\.hsbs)$/i,
	);
	return match ? { value: match[1]!, edition: match[2]!.trim() } : { value, edition: null };
}

/** Parse episode coordinates from every format explicitly documented by the naming guide. */
function episodeCoordinates(
	stem: string,
	seasonFolder: string,
): { season: number; episode: number; end: number | null; suffix: string } | null {
	const patterns = [
		// Matches "Show Name S03E17-E18" as season 3, episodes 17 through 18.
		/[s](\d{1,3})[\s._-]*[e](\d{1,6})(?:\s*-\s*[e](\d{1,6}))?/i,
		// Matches "Show Name 3x17-x18" as season 3, episodes 17 through 18.
		/(\d{1,3})x(\d{1,6})(?:\s*-\s*x?(\d{1,6}))?/i,
		// Matches "Show Name Season 3 Episode 17" as season 3, episode 17.
		/se(?:ason)?[\s._-]*(\d{1,3})[\s._-]*ep(?:isode)?[\s._-]*(\d{1,6})/i,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(stem);
		if (match) {
			return {
				season: Number(match[1]),
				episode: Number(match[2]),
				end: match[3] ? Number(match[3]) : null,
				suffix: stem.slice(match.index + match[0].length),
			};
		}
	}

	// Matches "3.17 Episode Name" as season 3, episode 17.
	const dotted = stem.match(/^(\d{1,3})\.(\d{1,6})[\s._-]*(.*)$/);
	if (dotted) {
		return {
			season: Number(dotted[1]),
			episode: Number(dotted[2]),
			end: null,
			suffix: dotted[3] ?? '',
		};
	}

	// Matches "3-17 Episode Name" as season 3, episode 17.
	const paired = stem.match(/^(\d{1,3})-(\d{2,6})[\s._-]*(.*)$/);
	if (paired) {
		return {
			season: Number(paired[1]),
			episode: Number(paired[2]),
			end: null,
			suffix: paired[3] ?? '',
		};
	}

	// Matches a containing folder such as "Season 3" and captures season 3.
	const seasonMatch = seasonFolder.match(/^season[\s._-]*(\d{1,3})$/i);
	// Transforms the containing folder name "Specials" to season zero.
	const season = /^specials$/i.test(seasonFolder) ? 0 : seasonMatch ? Number(seasonMatch[1]) : null;
	if (season === null) {
		return null;
	}

	// Matches "Episode 17 - Episode Name" within a recognized season folder.
	const explicit = stem.match(/^episode[\s._-]*(\d{1,6})(?:\s*-\s*)?(.*)$/i);
	if (explicit) {
		return { season, episode: Number(explicit[1]), end: null, suffix: explicit[2] ?? '' };
	}

	// Matches "17 Episode Name" within a recognized season folder.
	const episodeOnly = stem.match(/^(\d{1,6})[\s._-]+(.+)$/);
	return episodeOnly
		? { season, episode: Number(episodeOnly[1]), end: null, suffix: episodeOnly[2]! }
		: null;
}

/** Parse a movie, episode, or music-video filename using portable naming conventions. */
export function parseVideoFilename(
	relativePath: string,
	typeKey: string,
): ParsedVideoFilename {
	const stem = path.posix.basename(relativePath, path.posix.extname(relativePath));
	const split = multipart(stem);
	const tags = braceTags(split.logicalStem);
	const legacy = legacyEdition(tags.value);
	const dated = releaseYear(legacy.value);
	let title = readable(dated.value);
	let seasonNumber: number | null = null;
	let episodeNumber: number | null = null;
	let episodeEndNumber: number | null = null;
	let trackNumber: number | null = null;

	if (typeKey === 'shows') {
		const folder = path.posix.basename(path.posix.dirname(relativePath));
		const coordinates = episodeCoordinates(dated.value, folder);
		if (coordinates) {
			seasonNumber = coordinates.season;
			episodeNumber = coordinates.episode;
			episodeEndNumber = coordinates.end;
			title = readable(coordinates.suffix)
				|| (coordinates.end === null
					? `Episode ${coordinates.episode}`
					: `Episodes ${coordinates.episode}–${coordinates.end}`);
		}
	}
	else if (typeKey === 'music-videos') {
		// Matches "04 - Track Name" as track 4 with title "Track Name".
		const track = dated.value.match(/^(\d{1,6})\s*-\s*(.+)$/);
		if (track) {
			trackNumber = Number(track[1]);
			title = readable(track[2]!);
		}
	}

	return {
		title: title || readable(stem),
		year: dated.year,
		seasonNumber,
		episodeNumber,
		episodeEndNumber,
		edition: tags.edition ?? legacy.edition,
		externalIds: tags.externalIds,
		trackNumber,
		discNumber: null,
		part: split.part,
		logicalStem: split.logicalStem,
	};
}

/** Parse a show or other collection folder without retaining disambiguation tags in its title. */
export function parseCollectionFolder(folder: string): ParsedCollectionFolder {
	const tags = braceTags(folder);
	const dated = releaseYear(tags.value);
	return {
		title: readable(dated.value) || folder,
		year: dated.year,
		externalIds: tags.externalIds,
	};
}
