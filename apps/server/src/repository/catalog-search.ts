import type { MediaGroup, MediaSourceMatch } from '@moirai/shared';
import { foldMusicSearchText, musicTextMatches } from '../media/music-search.js';
import type { MoiraiDatabase } from '../db/index.js';
import type { RawItemRow } from './catalog-records.js';
import { mappedItem } from './catalog-records.js';
import { normalizeGenre, normalizeSearchText } from '../scanner/catalog-metadata.js';

/** Escape user text before placing it inside a SQL `LIKE` pattern. */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, '\\$&');
}

/** Record one deduplicated reason why a catalog source matched the current search. */
export function addSourceMatch(
	matches: Map<string, MediaSourceMatch[]>,
	id: string,
	match: MediaSourceMatch,
): void {
	const current = matches.get(id) ?? [];
	if (
		!current.some((candidate) => candidate.field === match.field && candidate.label === match.label)
	) {
		current.push(match);
		matches.set(id, current);
	}
}

/** Explain matches using paged item metadata and two bounded genre/people lookups. */
export function itemSourceMatches(
	db: MoiraiDatabase,
	rows: Array<
		RawItemRow & {
			groupTitle: string | null;
			groupKind: MediaGroup['kind'] | null;
			parentTitle: string | null;
			parentKind: MediaGroup['kind'] | null;
		}
	>,
	rawPattern: string,
	normalizedPattern: string,
	genrePattern: string,
): Map<string, MediaSourceMatch[]> {
	const matches = new Map<string, MediaSourceMatch[]>();
	const literalSearch = rawPattern
		.slice(1, -1)
		.replace(/\\([\\%_])/g, '$1');
	const rawSearch = literalSearch.toLocaleLowerCase();
	for (const row of rows) {
		const item = mappedItem(row);
		for (const artist of item.artists) {
			if (musicTextMatches(artist, literalSearch)) {
				addSourceMatch(matches, row.id, { field: 'artist', label: artist });
			}
		}
		const album = item.metadata.album;
		if (typeof album === 'string' && musicTextMatches(album, literalSearch)) {
			addSourceMatch(matches, row.id, { field: 'album', label: album });
		}
		if (row.plot?.toLocaleLowerCase().includes(rawSearch)) {
			addSourceMatch(matches, row.id, { field: 'plot', label: row.plot });
		}
		if (row.title.toLocaleLowerCase().includes(rawSearch)) {
			addSourceMatch(matches, row.id, { field: 'title', label: row.title });
		}
		for (const [label, kind] of [
			[row.groupTitle, row.groupKind],
			[row.parentTitle, row.parentKind],
		] as const) {
			const matched = label && (kind === 'artist' || kind === 'album'
				? musicTextMatches(label, literalSearch)
				: label.toLocaleLowerCase().includes(rawSearch));
			if (matched && kind) {
				addSourceMatch(matches, row.id, { field: kind, label });
			}
		}
	}
	const ids = rows.map((row) => row.id);
	if (ids.length === 0) {
		return matches;
	}

	const placeholders = ids.map(() => '?').join(', ');
	const genreRows = db.$client
		.prepare(
			`SELECT item_id AS itemId, genre_name AS label FROM media_item_genres
        WHERE item_id IN (${placeholders})
          AND (genre_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR genre_key LIKE ? ESCAPE '\\' COLLATE NOCASE)
        ORDER BY genre_name COLLATE NOCASE`,
		)
		.all(...ids, rawPattern, genrePattern) as Array<{ itemId: string; label: string }>;
	for (const row of genreRows) {
		addSourceMatch(matches, row.itemId, { field: 'genre', label: row.label });
	}
	const peopleRows = db.$client
		.prepare(
			`SELECT item_id AS itemId, person_type AS field, name AS label FROM media_item_people
        WHERE item_id IN (${placeholders}) AND normalized_name LIKE ? ESCAPE '\\'
        ORDER BY name COLLATE NOCASE`,
		)
		.all(...ids, normalizedPattern) as Array<{
		itemId: string;
		field: 'actor' | 'director';
		label: string;
	}>;
	for (const row of peopleRows) {
		addSourceMatch(matches, row.itemId, { field: row.field, label: row.label });
	}
	return matches;
}

/** Build a bounded text filter for music credits and their hierarchy labels. */
export function musicFieldPredicate(field: 'artist' | 'album', text: string): { sql: string; params: string[] } {
	const query = foldMusicSearchText(text);
	const metadata = field === 'artist'
		? 'EXISTS (SELECT 1 FROM json_each(i.artists) credit WHERE instr(moirai_music_fold(credit.value), ?) > 0)'
		: "instr(moirai_music_fold(json_extract(i.metadata, '$.album')), ?) > 0";
	return {
		sql: `(${metadata} OR EXISTS (
			SELECT 1 FROM media_groups mg LEFT JOIN media_groups mp ON mp.id = mg.parent_id
			WHERE mg.id = i.group_id AND ((mg.kind = '${field}' AND instr(moirai_music_fold(mg.title), ?) > 0)
			OR (mp.kind = '${field}' AND instr(moirai_music_fold(mp.title), ?) > 0))))`,
		params: [query, query, query],
	};
}

/** Share literal substring matching across catalog browsing and the source picker. */
export function itemSearchPredicate(text: string): {
	sql: string;
	params: string[];
	rawPattern: string;
	normalizedPattern: string;
	genrePattern: string;
} {
	const rawPattern = `%${escapeLike(text)}%`;
	const normalizedPattern = `%${escapeLike(normalizeSearchText(text))}%`;
	const genrePattern = `%${escapeLike(normalizeGenre(text)?.key ?? normalizeSearchText(text))}%`;
	const artist = musicFieldPredicate('artist', text);
	const album = musicFieldPredicate('album', text);
	return {
		sql: `(i.title LIKE ? ESCAPE '\\' COLLATE NOCASE
			OR i.plot LIKE ? ESCAPE '\\' COLLATE NOCASE
			OR EXISTS (SELECT 1 FROM media_item_genres sg WHERE sg.item_id = i.id
				AND (sg.genre_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR sg.genre_key LIKE ? ESCAPE '\\' COLLATE NOCASE))
			OR EXISTS (SELECT 1 FROM media_item_people sp WHERE sp.item_id = i.id AND sp.normalized_name LIKE ? ESCAPE '\\')
			OR EXISTS (SELECT 1 FROM media_groups sg LEFT JOIN media_groups parent ON parent.id = sg.parent_id
				WHERE sg.id = i.group_id AND (sg.title LIKE ? ESCAPE '\\' COLLATE NOCASE OR parent.title LIKE ? ESCAPE '\\' COLLATE NOCASE))
			OR ${artist.sql}
			OR ${album.sql})`,
		params: [rawPattern, rawPattern, rawPattern, genrePattern, normalizedPattern, rawPattern, rawPattern, ...artist.params, ...album.params],
		rawPattern,
		normalizedPattern,
		genrePattern,
	};
}
