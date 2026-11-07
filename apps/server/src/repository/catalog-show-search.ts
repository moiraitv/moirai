import type { MediaGroup, MediaSourceMatch, MediaSourcePickerEntry, MediaSourcePickerResult, MediaSourcePickerTarget } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { CATALOG_ITEM_COLUMNS, GROUP_CHILD_COUNT, SOURCE_GROUP_IDS, mappedGroup, mappedItem, type RawGroupRow, type RawItemRow } from './catalog-records.js';
import { ftsMatchQuery, itemSearchPredicate, itemSourceMatches } from './catalog-search.js';

/** Shared recursive scope and item filters, with bound parameters in SQL order. */
export interface FilteredItemScope {
	scopeCte: string;
	scopeParams: Array<string | number>;
	where: string;
	filterParams: Array<string | number>;
}

/** Numeric season metadata for a group aliased as `g`. */
const GROUP_SEASON_NUMBER = "CASE WHEN g.kind = 'season' THEN json_extract(g.metadata, '$.seasonNumber') END";

/** Keep displayed and bulk-selected episodes in the same order, including unknown numbers. */
export function showEpisodeOrder(alias: 'i' | 'page'): string {
	return `${alias}.season_number ASC NULLS LAST, ${alias}.episode_number ASC NULLS LAST, ${alias}.title COLLATE NOCASE, ${alias}.id`;
}

/** Order mixed TV candidates by type, numeric coordinates, title, and stable identity. */
const SHOW_SEARCH_ORDER = `page.kindRank, ${showEpisodeOrder('page')}`;

/** Keep explicit group searches in the same order as the group portion of mixed TV searches. */
export const SHOW_GROUP_SEARCH_ORDER = `CASE WHEN g.kind = 'show' THEN 0 ELSE 1 END,
	${GROUP_SEASON_NUMBER} ASC NULLS LAST,
	CASE WHEN g.kind = 'show' THEN g.sort_title ELSE g.title END COLLATE NOCASE, g.id`;

/** One page of TV search results, with an optional restriction on the returned source type. */
interface ShowSearchQuery {
	search: string;
	parentId: string | null;
	page: number;
	pageSize: number;
	target: MediaSourcePickerTarget;
	hasItemFilters: boolean;
}

/** Page row with either item ancestry or a separately named group record. */
type ShowSearchRow = {
	groupRecord: string;
	groupParentTitle: string | null;
} | (RawItemRow & {
	groupRecord: null;
	groupTitle: string | null;
	groupKind: MediaGroup['kind'] | null;
	parentTitle: string | null;
	parentKind: MediaGroup['kind'] | null;
});

/** Search TV sources together without loading metadata or child counts for off-page rows. */
export function browseShowSearch(
	db: MoiraiDatabase,
	libraryId: string,
	query: ShowSearchQuery,
	scope: FilteredItemScope,
): MediaSourcePickerResult & { matchedItemCount: number } {
	const fts = ftsMatchQuery(query.search);
	const patterns = itemSearchPredicate(query.search);
	const includeItems = query.target !== 'groups';
	const includeGroups = query.target !== 'items';

	/** Build one candidate relation for both the count and the ordered page. */
	function candidates(items: boolean, groups: boolean, itemLike: boolean, groupLike: boolean): {
		cte: string; params: Array<string | number>;
	} {
		const selects: string[] = [];
		const params = [...scope.scopeParams];
		if (items) {
			const predicate = itemSearchPredicate(query.search, { libraryId, forceLike: itemLike });
			selects.push(`SELECT i.id, 2 AS kindRank, i.season_number, i.episode_number, i.title
				FROM media_items i WHERE ${scope.where} AND i.kind = 'episode' AND ${predicate.sql}`);
			params.push(...scope.filterParams, ...predicate.params);
		}
		if (groups) {
			const parentScope = query.parentId ? 'AND g.id <> ? AND g.id IN (SELECT id FROM scope)' : '';
			const groupText = fts && !groupLike
				? "g.id IN (SELECT entity_id FROM catalog_search WHERE catalog_search MATCH ? AND entity_kind = 'group' AND library_id = ?)"
				: "(g.title LIKE ? ESCAPE '\\' COLLATE NOCASE OR g.plot LIKE ? ESCAPE '\\' COLLATE NOCASE)";
			const episodeFilter = query.hasItemFilters
				? `AND EXISTS (SELECT 1 FROM media_items i WHERE ${scope.where} AND i.kind = 'episode'
					AND i.group_id IN ${SOURCE_GROUP_IDS})`
				: '';
			selects.push(`SELECT g.id, CASE WHEN g.kind = 'show' THEN 0 ELSE 1 END AS kindRank,
				${GROUP_SEASON_NUMBER} AS season_number, NULL AS episode_number,
				CASE WHEN g.kind = 'show' THEN g.sort_title ELSE g.title END AS title
				FROM media_groups g WHERE g.library_id = ? AND g.kind IN ('show', 'season')
				${parentScope} AND ${groupText} ${episodeFilter}`);
			params.push(libraryId);
			if (query.parentId) {
				params.push(query.parentId);
			}
			params.push(...(fts && !groupLike ? [fts, libraryId] : [patterns.rawPattern, patterns.rawPattern]));
			if (query.hasItemFilters) {
				params.push(...scope.filterParams);
			}
		}

		const withScope = scope.scopeCte ? `${scope.scopeCte.trimEnd()},` : 'WITH';
		return { cte: `${withScope} candidates AS (${selects.join(' UNION ALL ')})`, params };
	}

	/** Count both result types so a group hit cannot suppress the episode substring fallback. */
	function counts(scope: ReturnType<typeof candidates>): { items: number; groups: number } {
		return db.$client.prepare(`${scope.cte}
			SELECT COUNT(*) FILTER (WHERE kindRank = 2) AS items,
				COUNT(*) FILTER (WHERE kindRank <> 2) AS groups FROM candidates`)
			.get(...scope.params) as { items: number; groups: number };
	}

	// Check indexed matches and retry missing types with the existing substring behavior.
	const indexed = candidates(includeItems, includeGroups, false, false);
	let { items, groups } = counts(indexed);
	const itemLike = Boolean(fts && includeItems && items === 0);
	const groupLike = Boolean(fts && includeGroups && groups === 0);
	if (itemLike || groupLike) {
		const fallback = counts(candidates(itemLike, groupLike, itemLike, groupLike));
		items += fallback.items;
		groups += fallback.groups;
	}
	const totalEntries = items + groups;
	const pagination = {
		page: query.page,
		pageSize: query.pageSize,
		totalEntries,
		totalPages: Math.max(1, Math.ceil(totalEntries / query.pageSize)),
	};
	const offset = (query.page - 1) * query.pageSize;
	if (offset >= totalEntries) {
		return { entries: [], pagination, matchedItemCount: items };
	}

	// Hydrate and explain just the selected page. Item and group IDs occupy separate row kinds.
	const { cte, params } = candidates(items > 0, groups > 0, itemLike, groupLike);
	const rows = db.$client.prepare(`${cte}, page AS (
		SELECT page.* FROM candidates page ORDER BY ${SHOW_SEARCH_ORDER} LIMIT ? OFFSET ?
	)
	SELECT ${CATALOG_ITEM_COLUMNS}, item_group.title AS groupTitle, item_group.kind AS groupKind,
		item_parent.title AS parentTitle, item_parent.kind AS parentKind,
		CASE WHEN item_group.kind = 'show' THEN item_group.id WHEN item_parent.kind = 'show' THEN item_parent.id END AS showId,
		CASE WHEN item_group.kind = 'show' THEN item_group.sort_title WHEN item_parent.kind = 'show' THEN item_parent.sort_title END AS showSortTitle,
		group_parent.title AS groupParentTitle,
		CASE WHEN g.id IS NOT NULL THEN json_object(
			'id', g.id, 'libraryId', g.library_id, 'parentId', g.parent_id, 'kind', g.kind,
			'title', g.title, 'sortTitle', g.sort_title, 'year', g.year, 'plot', g.plot,
			'metadata', g.metadata, 'artworkRelativePath', g.artwork_relative_path,
			'parentArtworkRelativePath', group_parent.artwork_relative_path,
			'parentMetadata', group_parent.metadata, 'childCount', ${GROUP_CHILD_COUNT}
		) END AS groupRecord
	FROM page
	LEFT JOIN media_items i ON page.kindRank = 2 AND i.id = page.id
	LEFT JOIN media_groups item_group ON item_group.id = i.group_id AND item_group.library_id = i.library_id
	LEFT JOIN media_groups item_parent ON item_parent.id = item_group.parent_id AND item_parent.library_id = i.library_id
	LEFT JOIN media_groups g ON page.kindRank <> 2 AND g.id = page.id
	LEFT JOIN media_groups group_parent ON group_parent.id = g.parent_id AND group_parent.library_id = g.library_id
	ORDER BY ${SHOW_SEARCH_ORDER}`)
		.all(...params, query.pageSize, offset) as ShowSearchRow[];
	const itemRows = rows.filter((row) => row.groupRecord === null);
	const matches = itemSourceMatches(db, itemRows, patterns.rawPattern, patterns.normalizedPattern, patterns.genrePattern);
	const searchText = query.search.toLocaleLowerCase();
	const entries = rows.map((row): MediaSourcePickerEntry => {
		const display = { navigationKey: '', sectionKey: null, sectionLabel: null };
		if (row.groupRecord === null) {
			const item = mappedItem(row);
			const parentTitle = row.parentTitle ?? row.groupTitle;
			return { ...display, navigationKey: includeGroups ? '' : item.titleBucket,
				key: item.id, kind: 'item', item, group: null,
				matches: matches.get(item.id) ?? [], ...(parentTitle ? { parentTitle } : {}) };
		}

		const group = mappedGroup(JSON.parse(row.groupRecord) as RawGroupRow);
		const groupMatches: MediaSourceMatch[] = [];
		if (group.title.toLocaleLowerCase().includes(searchText)) {
			groupMatches.push({ field: 'title', label: group.title });
		}
		if (group.plot?.toLocaleLowerCase().includes(searchText)) {
			groupMatches.push({ field: 'plot', label: group.plot });
		}
		return { ...display, key: group.id, kind: 'group', item: null, group, matches: groupMatches,
			...(row.groupParentTitle ? { parentTitle: row.groupParentTitle } : {}) };
	});
	return { entries, pagination, matchedItemCount: items };
}
