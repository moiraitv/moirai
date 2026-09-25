import type Database from 'better-sqlite3';
import type { MediaGenreFacet } from '@moirai/shared';
import type { MediaGenreFacetSelection } from './contracts.js';

/**
 * Count prospective rules in one query. Items failing only the current genre's rule can rejoin
 * that facet; items failing several rules cannot. Indexed matches avoid an item-by-rule cross join.
 * Subtracting matched positive rule IDs and adding violated exclusion IDs identifies the failed
 * rule when exactly one fails; the summed ID is ignored when several rules fail.
 */
export function listGenreFacets(
	sqlite: Database.Database,
	libraryId: string,
	selection: MediaGenreFacetSelection | null,
): MediaGenreFacet[] {
	if (!selection) {
		return sqlite.prepare(`SELECT g.genre_key AS key, g.genre_name AS name, COUNT(*) AS count,
			SUM(CASE WHEN i.primary_genre_key = g.genre_key THEN 1 ELSE 0 END) AS primaryCount,
			NULL AS excludeCount FROM media_item_genres g JOIN media_items i ON i.id = g.item_id
			WHERE g.library_id = ? GROUP BY g.genre_key, g.genre_name ORDER BY g.genre_name COLLATE NOCASE
		`).all(libraryId) as MediaGenreFacet[];
	}

	const rules = [
		...[...new Set(selection.genres)].map((key) => ({ key, kind: 'has' })),
		...[...new Set(selection.primaryGenres)].map((key) => ({ key, kind: 'primary' })),
		...[...new Set(selection.excludedGenres)].map((key) => ({ key, kind: 'exclude' })),
	];
	return sqlite.prepare(`
		WITH rules AS MATERIALIZED (
			SELECT CAST(key AS INTEGER) + 1 AS rule_id,
				json_extract(value, '$.key') AS genre_key, json_extract(value, '$.kind') AS kind
			FROM json_each(?)
		), positive_totals AS (
			SELECT COUNT(*) AS count, COALESCE(SUM(rule_id), 0) AS rule_sum FROM rules WHERE kind != 'exclude'
		), matched_rules AS (
			SELECT g.item_id AS id, r.rule_id, r.kind
			FROM media_item_genres g JOIN rules r ON r.genre_key = g.genre_key AND r.kind != 'primary'
			WHERE g.library_id = ?
			UNION ALL
			SELECT i.id, r.rule_id, r.kind
			FROM media_items i JOIN rules r ON r.genre_key = i.primary_genre_key AND r.kind = 'primary'
			WHERE i.library_id = ?
		), matched_totals AS (
			SELECT id,
				SUM(CASE WHEN kind = 'exclude' THEN 1 ELSE -1 END) AS count_delta,
				SUM(CASE WHEN kind = 'exclude' THEN rule_id ELSE -rule_id END) AS rule_delta
			FROM matched_rules GROUP BY id
		), failures AS (
			SELECT i.id, p.count + COALESCE(m.count_delta, 0) AS count, r.genre_key
			FROM media_items i CROSS JOIN positive_totals p
			LEFT JOIN matched_totals m ON m.id = i.id
			LEFT JOIN rules r ON r.rule_id = p.rule_sum + COALESCE(m.rule_delta, 0)
			WHERE i.library_id = ? AND p.count + COALESCE(m.count_delta, 0) > 0
		), eligible AS (
			SELECT i.id, i.primary_genre_key FROM media_items i
			LEFT JOIN failures f ON f.id = i.id
			WHERE i.library_id = ? AND f.id IS NULL
		), totals AS (
			SELECT COUNT(*) AS count FROM eligible
		), rescued AS (
			SELECT f.genre_key, COUNT(*) AS count FROM failures f
			WHERE f.count = 1 GROUP BY f.genre_key
		), memberships AS (
			SELECT g.genre_key, g.genre_name,
				SUM(CASE WHEN f.id IS NULL OR (f.count = 1 AND f.genre_key = g.genre_key) THEN 1 ELSE 0 END) AS count,
				SUM(CASE WHEN (f.id IS NULL OR (f.count = 1 AND f.genre_key = g.genre_key))
					AND i.primary_genre_key = g.genre_key THEN 1 ELSE 0 END) AS primary_count
			FROM media_item_genres g JOIN media_items i ON i.id = g.item_id
			LEFT JOIN failures f ON f.id = i.id
			WHERE g.library_id = ? GROUP BY g.genre_key, g.genre_name
		)
		SELECT m.genre_key AS key, m.genre_name AS name, m.count,
			m.primary_count AS primaryCount,
			t.count + COALESCE(r.count, 0) - m.count AS excludeCount
		FROM memberships m CROSS JOIN totals t LEFT JOIN rescued r ON r.genre_key = m.genre_key
		ORDER BY m.genre_name COLLATE NOCASE
	`).all(JSON.stringify(rules), libraryId, libraryId, libraryId, libraryId, libraryId) as MediaGenreFacet[];
}
