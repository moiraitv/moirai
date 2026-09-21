import type {
	CatalogProgramItemQuery,
	LibraryContentPreview,
	MediaBrowseResult,
	MediaCardPreview,
	MediaGenreFacet,
	MediaGroup,
	MediaItem,
	MediaItemDetail,
	MediaSourceMatch,
	MediaSourcePickerEntry,
	MediaSourcePickerResult,
} from '@moirai/shared';
import { DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { addSourceMatch, escapeLike, ftsMatchQuery, itemSourceMatches, itemSearchPredicate, musicFieldPredicate } from './catalog-search.js';
import { normalizeGenre, normalizeSearchText } from '../scanner/catalog-metadata.js';
import type {
	MediaBrowseQuery,
	MediaFileOwner,
	MediaGenreFacetSelection,
	MediaProbeCacheEntry,
	MediaSourcePickerQuery,
	ProgramItemSelection,
} from './contracts.js';
import { CatalogAssetsRepository } from './catalog-assets.js';
import {
	mappedGroup,
	mappedItem,
} from './catalog-records.js';
import type { RawGroupRow, RawItemRow } from './catalog-records.js';

export {
	artworkUrl,
	inheritedGroupArtworkUrl,
	cacheVersion,
	decodedMetadata,
	metadataNumber,
	metadataPersonNames,
	metadataReleaseDate,
	metadataStrings,
} from './catalog-records.js';

/** Parameterized SQL fragments shared by flattened browsing and bulk program selection. */
interface FilteredItemScope {
	scopeCte: string;
	where: string;
	params: Array<string | number>;
}

/**
 * Provide indexed catalog browsing, lookup, and artwork-owner queries. This repository translates
 * persistent catalog rows into stable hierarchy, search, detail, and source-picker views while
 * delegating non-paginated asset lookups.
 */
export class MediaCatalogRepository {
	private readonly assets: CatalogAssetsRepository;

	constructor(private readonly db: MoiraiDatabase) {
		this.assets = new CatalogAssetsRepository(db);
	}

	/** Build one recursive, parameterized item scope from the shared catalog filter contract. */
	private filteredItemScope(
		libraryId: string,
		query: CatalogProgramItemQuery,
		forceLike = false,
	): FilteredItemScope {
		const scopeParams: Array<string | number> = [];
		let scopeCte = '';
		const conditions = ['i.library_id = ?'];
		const conditionParams: Array<string | number> = [libraryId];
		if (query.parentId) {
			scopeCte
				= 'WITH RECURSIVE scope(id) AS (SELECT ? UNION ALL SELECT g.id FROM media_groups g JOIN scope s ON g.parent_id = s.id) ';
			scopeParams.push(query.parentId);
			conditions.push('i.group_id IN (SELECT id FROM scope)');
		}
		if (query.search) {
			const libraryType = this.db.$client
				.prepare('SELECT type_key AS typeKey FROM libraries WHERE id = ?')
				.get(libraryId) as { typeKey: string } | undefined;
			const search = itemSearchPredicate(query.search, {
				libraryId,
				includeMusic: libraryType?.typeKey === 'music-videos',
				forceLike,
			});
			conditions.push(search.sql);
			conditionParams.push(...search.params);
		}
		for (const field of ['artist', 'album'] as const) {
			if (query[field]) {
				const filter = musicFieldPredicate(field, query[field]);
				conditions.push(filter.sql);
				conditionParams.push(...filter.params);
			}
		}

		if (query.name) {
			conditions.push("i.title LIKE ? ESCAPE '\\' COLLATE NOCASE");
			conditionParams.push(`%${escapeLike(query.name)}%`);
		}
		if (query.releaseYearFrom !== null) {
			conditions.push('i.year >= ?');
			conditionParams.push(query.releaseYearFrom);
		}
		if (query.releaseYearTo !== null) {
			conditions.push('i.year <= ?');
			conditionParams.push(query.releaseYearTo);
		}
		if (query.minimumDurationSeconds != null) {
			conditions.push('i.duration_milliseconds / 1000.0 >= ?');
			conditionParams.push(query.minimumDurationSeconds);
		}
		if (query.maximumDurationSeconds != null) {
			conditions.push('i.duration_milliseconds / 1000.0 <= ?');
			conditionParams.push(query.maximumDurationSeconds);
		}
		if (query.minimumRating !== null) {
			conditions.push("json_extract(i.metadata, '$.rating') >= ?");
			conditionParams.push(query.minimumRating);
		}
		if (query.minimumUserRating !== null) {
			conditions.push("json_extract(i.metadata, '$.userRating') >= ?");
			conditionParams.push(query.minimumUserRating);
		}
		if (query.addedFrom) {
			conditions.push('i.date_added_at >= ?');
			conditionParams.push(query.addedFrom);
		}
		if (query.addedBefore) {
			conditions.push('i.date_added_at < ?');
			conditionParams.push(query.addedBefore);
		}
		if (query.genres.length > 0) {
			const placeholders = query.genres.map(() => '?').join(', ');
			if (query.genreMatch === 'all') {
				conditions.push(
					`(SELECT COUNT(DISTINCT fg.genre_key) FROM media_item_genres fg WHERE fg.item_id = i.id AND fg.genre_key IN (${placeholders})) = ?`,
				);
				conditionParams.push(...query.genres, query.genres.length);
			}
			else {
				conditions.push(
					`EXISTS (SELECT 1 FROM media_item_genres fg WHERE fg.item_id = i.id AND fg.genre_key IN (${placeholders}))`,
				);
				conditionParams.push(...query.genres);
			}
		}
		if (query.excludedGenres.length > 0) {
			const placeholders = query.excludedGenres.map(() => '?').join(', ');
			conditions.push(
				`NOT EXISTS (SELECT 1 FROM media_item_genres eg WHERE eg.item_id = i.id AND eg.genre_key IN (${placeholders}))`,
			);
			conditionParams.push(...query.excludedGenres);
		}
		for (const [type, value] of [
			['actor', query.actor],
			['director', query.director],
		] as const) {
			if (value) {
				conditions.push(
					"EXISTS (SELECT 1 FROM media_item_people fp WHERE fp.item_id = i.id AND fp.person_type = ? AND fp.normalized_name LIKE ? ESCAPE '\\')",
				);
				conditionParams.push(type, `%${escapeLike(normalizeSearchText(value))}%`);
			}
		}

		return {
			scopeCte,
			where: conditions.join(' AND '),
			params: [...scopeParams, ...conditionParams],
		};
	}

	/** Return cached probe facts for every indexed item in one library. */
	async listMediaProbeCache(libraryId: string): Promise<MediaProbeCacheEntry[]> {
		return this.assets.listMediaProbeCache(libraryId);
	}

	/** Return whether a library contains media without a successful technical probe. */
	async libraryNeedsMediaProbe(libraryId: string): Promise<boolean> {
		return this.assets.libraryNeedsMediaProbe(libraryId);
	}

	/** Collect the stable identifiers for existing artwork owner. */
	async existingArtworkOwnerIds(
		libraryId: string,
		kind: 'items' | 'groups',
		ids: string[],
	): Promise<Set<string>> {
		return this.assets.existingArtworkOwnerIds(libraryId, kind, ids);
	}

	/** Browse a library with stable, URL-addressable sorting, filtering, and pagination. */
	async browseMedia(libraryId: string, query: MediaBrowseQuery): Promise<MediaBrowseResult> {
		// Preserve hierarchy only for the unfiltered title view.
		const hasFilters = Boolean(
			query.name
			|| query.search
			|| query.artist
			|| query.album
			|| query.actor
			|| query.director
			|| query.releaseYearFrom !== null
			|| query.releaseYearTo !== null
			|| query.minimumDurationSeconds != null
			|| query.maximumDurationSeconds != null
			|| query.minimumRating !== null
			|| query.minimumUserRating !== null
			|| query.addedFrom
			|| query.addedBefore
			|| query.genres.length
			|| query.excludedGenres.length,
		);
		const flattenHierarchy = hasFilters || query.sort !== 'title';
		if (!flattenHierarchy) {
			return this.browseHierarchy(libraryId, query);
		}

		// Build a parameterized flattened scope and its requested filters.
		let forceLike = false;
		let scopeCte = '';
		let where = '';
		let allParams: Array<string | number> = [];
		let navigation: MediaBrowseResult['navigation'] = [];
		let totalEntries = 0;
		for (;;) {
			({ scopeCte, where, params: allParams } = this.filteredItemScope(libraryId, query, forceLike));
			navigation = [];
			totalEntries = 0;

			// Derive section navigation and total entries from the active sort mode.
			if (query.sort === 'title' && !query.search) {
				const rows = this.db.$client
					.prepare(
						`${scopeCte}SELECT i.title_bucket AS key, i.title_bucket AS label, COUNT(*) AS count FROM media_items i WHERE ${where} GROUP BY i.title_bucket ORDER BY CASE WHEN i.title_bucket = '#' THEN 0 ELSE 1 END ${query.direction === 'asc' ? 'ASC' : 'DESC'}, i.title_bucket ${query.direction.toUpperCase()}`,
					)
					.all(...allParams) as Array<{ key: string; label: string; count: number }>;
				navigation = this.navigationWithPages(rows, query.pageSize);
				totalEntries = rows.reduce((sum, row) => sum + row.count, 0);
			}
			else if (query.sort === 'genre') {
				const rows = this.db.$client
					.prepare(
						`${scopeCte}SELECT pg.genre_key AS key, pg.genre_name AS label, COUNT(*) AS count FROM media_items i JOIN media_item_genres pg ON pg.item_id = i.id WHERE ${where} GROUP BY pg.genre_key, pg.genre_name ORDER BY pg.genre_name COLLATE NOCASE ${query.direction.toUpperCase()}`,
					)
					.all(...allParams) as Array<{ key: string; label: string; count: number }>;
				navigation = this.navigationWithPages(rows, query.pageSize);
				totalEntries = rows.reduce((sum, row) => sum + row.count, 0);
			}
			else {
				const row = this.db.$client
					.prepare(`${scopeCte}SELECT COUNT(*) AS count FROM media_items i WHERE ${where}`)
					.get(...allParams) as { count: number };
				totalEntries = row.count;
			}
			if (!forceLike && query.search && ftsMatchQuery(query.search) && totalEntries === 0) {
				forceLike = true;
				continue;
			}

			break;
		}

		// Fetch the requested page with stable tie-breaking across duplicate titles.
		const itemColumns = `i.id, i.library_id AS libraryId, i.group_id AS groupId, i.stable_key AS stableKey,
      i.kind, i.title, i.sort_title AS sortTitle, i.relative_path AS relativePath,
      i.playback_path AS playbackPath, i.plot, i.year,
      i.duration_milliseconds / 1000.0 AS durationSeconds,
      i.season_number AS seasonNumber, i.episode_number AS episodeNumber,
	  i.episode_end_number AS episodeEndNumber, i.edition, i.external_ids AS externalIds,
	  i.track_number AS trackNumber, i.disc_number AS discNumber, i.artists,
	  i.multipart_status AS multipartStatus, i.parts, i.subtitle_tracks AS subtitleTracks,
      i.metadata_status AS metadataStatus, i.availability,
      i.last_observed_at AS lastObservedAt, i.metadata,
      i.artwork_relative_path AS artworkRelativePath,
      i.fingerprint, i.file_modified_at AS fileModifiedAt, i.date_added_at AS dateAddedAt,
      i.title_bucket AS titleBucket, i.created_at AS createdAt, i.updated_at AS updatedAt`;
		const direction = query.direction.toUpperCase();
		const join = (query.sort === 'genre' ? 'JOIN media_item_genres pg ON pg.item_id = i.id ' : '')
			+ (query.search ? 'LEFT JOIN media_groups g ON g.id = i.group_id LEFT JOIN media_groups parent ON parent.id = g.parent_id' : '');
		const searchColumns = query.search ? ', g.title AS groupTitle, g.kind AS groupKind, parent.title AS parentTitle, parent.kind AS parentKind' : '';
		const sectionColumns
			= query.sort === 'genre'
				? ', pg.genre_key AS sectionKey, pg.genre_name AS sectionLabel'
				: ', NULL AS sectionKey, NULL AS sectionLabel';
		const order
			= query.sort === 'date-added'
				? `i.date_added_at ${direction}, i.sort_title COLLATE NOCASE ASC, i.id ASC`
				: query.sort === 'genre'
					? `pg.genre_name COLLATE NOCASE ${direction}, i.sort_title COLLATE NOCASE ASC, i.id ASC`
					: `CASE WHEN i.title_bucket = '#' THEN 0 ELSE 1 END ${query.direction === 'asc' ? 'ASC' : 'DESC'}, i.sort_title COLLATE NOCASE ${direction}, i.id ${direction}`;
		const offset = (query.page - 1) * query.pageSize;
		const rows = this.db.$client
			.prepare(
				`${scopeCte}SELECT ${itemColumns}${sectionColumns}${searchColumns} FROM media_items i ${join} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
			)
			.all(...allParams, query.pageSize, offset) as Array<RawItemRow & { groupTitle: string | null; groupKind: MediaGroup['kind'] | null; parentTitle: string | null; parentKind: MediaGroup['kind'] | null }>;

		const patterns = itemSearchPredicate(query.search ?? '');
		const matches = query.search
			? itemSourceMatches(this.db, rows, patterns.rawPattern, patterns.normalizedPattern, patterns.genrePattern)
			: null;

		// Attach section keys used by scroll-aware sub-navigation in the SPA.
		const items = rows.map(mappedItem);
		const entries = items.map((item, index) => ({
			key: query.sort === 'genre' ? `${rows[index]!.sectionKey}:${item.id}` : item.id,
			kind: 'item' as const,
			navigationKey: query.sort === 'title'
				? item.titleBucket
				: query.sort === 'genre'
					? (rows[index]!.sectionKey ?? '')
					: '',
			sectionKey: rows[index]!.sectionKey ?? null,
			sectionLabel: rows[index]!.sectionLabel ?? null,
			item,
			group: null,
			...(matches ? { matches: matches.get(item.id) ?? [] } : {}),
		}));
		return {
			entries,
			groups: [],
			items,
			pagination: {
				page: query.page,
				pageSize: query.pageSize,
				totalEntries,
				totalPages: Math.max(1, Math.ceil(totalEntries / query.pageSize)),
			},
			navigation,
		};
	}

	/** Resolve a recursive filtered item set in stable catalog order with one overflow sentinel. */
	resolveProgramItemSelection(
		libraryId: string,
		query: CatalogProgramItemQuery,
		maxItemCount = DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS,
	): ProgramItemSelection {
		let { scopeCte, where, params } = this.filteredItemScope(libraryId, query);
		let selectionWhere = query.sort === 'genre'
			? `${where} AND EXISTS (SELECT 1 FROM media_item_genres sg WHERE sg.item_id = i.id)`
			: where;
		let matchedItemCount = (
			this.db.$client
				.prepare(`${scopeCte}SELECT COUNT(*) AS count FROM media_items i WHERE ${selectionWhere}`)
				.get(...params) as { count: number }
		).count;
		if (query.search && ftsMatchQuery(query.search) && matchedItemCount === 0) {
			({ scopeCte, where, params } = this.filteredItemScope(libraryId, query, true));
			selectionWhere = query.sort === 'genre'
				? `${where} AND EXISTS (SELECT 1 FROM media_item_genres sg WHERE sg.item_id = i.id)`
				: where;
			matchedItemCount = (
				this.db.$client
					.prepare(`${scopeCte}SELECT COUNT(*) AS count FROM media_items i WHERE ${selectionWhere}`)
					.get(...params) as { count: number }
			).count;
		}
		const direction = query.direction.toUpperCase();
		const genreAggregate = query.direction === 'asc' ? 'MIN' : 'MAX';
		const order = query.sort === 'date-added'
			? `i.date_added_at ${direction}, i.sort_title COLLATE NOCASE ASC, i.id ASC`
			: query.sort === 'genre'
				? `(SELECT ${genreAggregate}(sg.genre_name) FROM media_item_genres sg WHERE sg.item_id = i.id) COLLATE NOCASE ${direction}, i.sort_title COLLATE NOCASE ASC, i.id ASC`
				: `CASE WHEN i.title_bucket = '#' THEN 0 ELSE 1 END ${query.direction === 'asc' ? 'ASC' : 'DESC'}, i.sort_title COLLATE NOCASE ${direction}, i.id ${direction}`;
		const rows = this.db.$client
			.prepare(
				`${scopeCte}SELECT i.id FROM media_items i WHERE ${selectionWhere} ORDER BY ${order} LIMIT ?`,
			)
			.all(...params, maxItemCount + 1) as Array<{ id: string }>;

		return { itemIds: rows.map((row) => row.id), matchedItemCount };
	}

	/** Browse one hierarchical catalog level with stable filtering and pagination. */
	private browseHierarchy(libraryId: string, query: MediaBrowseQuery): MediaBrowseResult {
		// Build a combined group-and-item scope for one hierarchy level.
		const groupParent = query.parentId ? 'g.parent_id = ?' : 'g.parent_id IS NULL';
		const itemParent = query.parentId ? 'i.group_id = ?' : 'i.group_id IS NULL';
		const match = query.search ? ftsMatchQuery(query.search) : null;
		const likePattern = query.search ? `%${escapeLike(query.search)}%` : '';
		const groupSearch = query.search
			? (match
				? ' AND g.id IN (SELECT entity_id FROM catalog_search WHERE catalog_search MATCH ? AND entity_kind = \'group\' AND library_id = ?)'
				: ' AND (g.title LIKE ? ESCAPE \'\\\' COLLATE NOCASE OR COALESCE(g.plot, \'\') LIKE ? ESCAPE \'\\\' COLLATE NOCASE)')
			: '';
		const itemSearch = query.search
			? (match
				? ' AND i.id IN (SELECT entity_id FROM catalog_search WHERE catalog_search MATCH ? AND entity_kind = \'item\' AND library_id = ?)'
				: ' AND (i.title LIKE ? ESCAPE \'\\\' COLLATE NOCASE OR COALESCE(i.plot, \'\') LIKE ? ESCAPE \'\\\' COLLATE NOCASE)')
			: '';
		const searchParams = match ? [match, libraryId] : query.search ? [likePattern, likePattern] : [];
		const params = query.parentId
			? [libraryId, query.parentId, ...searchParams, libraryId, query.parentId, ...searchParams]
			: [libraryId, ...searchParams, libraryId, ...searchParams];
		const groupBucket
			= "CASE WHEN upper(substr(trim(g.sort_title), 1, 1)) BETWEEN 'A' AND 'Z' THEN upper(substr(trim(g.sort_title), 1, 1)) ELSE '#' END";
		const catalogKeys = `WITH catalog AS (
      SELECT ${groupBucket} AS titleBucket FROM media_groups g WHERE g.library_id = ? AND ${groupParent}${groupSearch}
      UNION ALL
      SELECT i.title_bucket AS titleBucket FROM media_items i WHERE i.library_id = ? AND ${itemParent}${itemSearch}
    )`;
		const navRows = this.db.$client
			.prepare(
				`${catalogKeys} SELECT titleBucket AS key, titleBucket AS label, COUNT(*) AS count FROM catalog GROUP BY titleBucket ORDER BY CASE WHEN titleBucket = '#' THEN 0 ELSE 1 END ${query.direction === 'asc' ? 'ASC' : 'DESC'}, titleBucket ${query.direction.toUpperCase()}`,
			)
			.all(...params) as Array<{ key: string; label: string; count: number }>;
		const totalEntries = navRows.reduce((sum, row) => sum + row.count, 0);

		// Page groups and items together using their shared title bucket and sort title.
		const offset = (query.page - 1) * query.pageSize;
		const catalogRows = `WITH catalog AS (
      SELECT 'group' AS rowKind, g.id, g.library_id AS libraryId, g.parent_id AS groupId,
        g.stable_key AS stableKey, g.kind, g.title, g.sort_title AS sortTitle,
        NULL AS relativePath, NULL AS playbackPath, g.plot, g.year,
        NULL AS durationSeconds, NULL AS seasonNumber, NULL AS episodeNumber,
		NULL AS episodeEndNumber, NULL AS edition, '[]' AS externalIds,
		NULL AS trackNumber, NULL AS discNumber, '[]' AS artists,
		'none' AS multipartStatus, '[]' AS parts, '[]' AS subtitleTracks,
        NULL AS metadataStatus, NULL AS availability, NULL AS lastObservedAt,
        g.metadata, g.artwork_relative_path AS artworkRelativePath,
        parent.artwork_relative_path AS parentArtworkRelativePath, parent.metadata AS parentMetadata,
        '' AS fingerprint, NULL AS fileModifiedAt, g.created_at AS dateAddedAt,
        ${groupBucket} AS titleBucket, g.created_at AS createdAt, g.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM media_groups child WHERE child.parent_id = g.id) +
          (SELECT COUNT(*) FROM media_items child_item WHERE child_item.group_id = g.id) AS childCount
      FROM media_groups g LEFT JOIN media_groups parent ON parent.id = g.parent_id AND parent.library_id = g.library_id
      WHERE g.library_id = ? AND ${groupParent}${groupSearch}
      UNION ALL
      SELECT 'item' AS rowKind, i.id, i.library_id AS libraryId, i.group_id AS groupId,
        i.stable_key AS stableKey, i.kind, i.title, i.sort_title AS sortTitle,
        i.relative_path AS relativePath, i.playback_path AS playbackPath, i.plot, i.year,
        i.duration_milliseconds / 1000.0 AS durationSeconds, i.season_number AS seasonNumber,
		i.episode_number AS episodeNumber,
		i.episode_end_number AS episodeEndNumber, i.edition, i.external_ids AS externalIds,
		i.track_number AS trackNumber, i.disc_number AS discNumber, i.artists,
		i.multipart_status AS multipartStatus, i.parts, i.subtitle_tracks AS subtitleTracks,
		i.metadata_status AS metadataStatus, i.availability,
		i.last_observed_at AS lastObservedAt, i.metadata,
        i.artwork_relative_path AS artworkRelativePath, NULL AS parentArtworkRelativePath, NULL AS parentMetadata, i.fingerprint,
        i.file_modified_at AS fileModifiedAt, i.date_added_at AS dateAddedAt,
        i.title_bucket AS titleBucket, i.created_at AS createdAt, i.updated_at AS updatedAt,
        0 AS childCount
      FROM media_items i WHERE i.library_id = ? AND ${itemParent}${itemSearch}
    )`;
		const rows = this.db.$client
			.prepare(
				`${catalogRows} SELECT * FROM catalog ORDER BY CASE WHEN titleBucket = '#' THEN 0 ELSE 1 END ${query.direction === 'asc' ? 'ASC' : 'DESC'}, sortTitle COLLATE NOCASE ${query.direction.toUpperCase()}, id ${query.direction.toUpperCase()} LIMIT ? OFFSET ?`,
			)
			.all(...params, query.pageSize, offset) as Array<
			RawItemRow & Pick<RawGroupRow, 'parentArtworkRelativePath' | 'parentMetadata'> & { rowKind: 'group' | 'item'; childCount: number }
		>;

		// Restore the distinct public contracts after reading the unified SQL result.
		const patterns = query.search ? itemSearchPredicate(query.search, { libraryId }) : null;
		const itemMatches = patterns
			? itemSourceMatches(
				this.db,
				rows.filter((row) => row.rowKind === 'item').map((row) => ({
					...row,
					groupTitle: null,
					groupKind: null,
					parentTitle: null,
					parentKind: null,
				})),
				patterns.rawPattern,
				patterns.normalizedPattern,
				patterns.genrePattern,
			)
			: null;
		const searchText = query.search?.trim().toLocaleLowerCase() ?? '';
		const entries = rows.map((row) => {
			if (row.rowKind === 'item') {
				const item = mappedItem(row);
				return {
					key: item.id,
					kind: 'item' as const,
					navigationKey: item.titleBucket,
					sectionKey: null,
					sectionLabel: null,
					item,
					group: null,
					...(itemMatches ? { matches: itemMatches.get(item.id) ?? [] } : {}),
				};
			}

			const group = mappedGroup({
				...row,
				parentId: row.groupId,
				kind: row.kind as MediaGroup['kind'],
			});
			return {
				key: group.id,
				kind: 'group' as const,
				navigationKey: row.titleBucket,
				sectionKey: null,
				sectionLabel: null,
				item: null,
				group,
				...(searchText
					? {
						matches: group.title.toLocaleLowerCase().includes(searchText)
							? [{ field: group.kind, label: group.title }]
							: [],
					}
					: {}),
			};
		});
		const groups = entries.flatMap((entry) => (entry.group ? [entry.group] : []));
		const items = entries.flatMap((entry) => (entry.item ? [entry.item] : []));
		return {
			entries,
			groups,
			items,
			pagination: {
				page: query.page,
				pageSize: query.pageSize,
				totalEntries,
				totalPages: Math.max(1, Math.ceil(totalEntries / query.pageSize)),
			},
			navigation: this.navigationWithPages(navRows, query.pageSize),
		};
	}

	/** Browse selectable scheduling sources without leaking non-selectable catalog rows. */
	async browseMediaSourceOptions(
		libraryId: string,
		query: MediaSourcePickerQuery,
	): Promise<MediaSourcePickerResult> {
		if (query.target === 'groups') {
			return this.browseGroupSourceOptions(libraryId, query);
		}

		if (!query.search) {
			const browse = await this.browseMedia(libraryId, {
				parentId: query.parentId,
				page: query.page,
				pageSize: query.pageSize,
				sort: 'title',
				direction: 'asc',
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
				excludedGenres: [],
				genreMatch: 'any',
				actor: '',
				director: '',
			});
			return {
				entries: browse.entries.map((entry) => ({ ...entry, matches: [] })),
				pagination: browse.pagination,
			};
		}

		return this.searchItemSourceOptions(libraryId, query);
	}

	/** Search playable items and include the metadata field that matched. */
	private searchItemSourceOptions(
		libraryId: string,
		query: MediaSourcePickerQuery,
	): MediaSourcePickerResult {
		// Search titles, hierarchy labels, normalized genres, and normalized people together.
		const rawPattern = `%${escapeLike(query.search)}%`;
		const normalizedPattern = `%${escapeLike(normalizeSearchText(query.search))}%`;
		const normalizedGenre = normalizeGenre(query.search);
		const genrePattern = `%${escapeLike(normalizedGenre?.key ?? normalizeSearchText(query.search))}%`;
		const scopeCte = query.parentId
			? 'WITH RECURSIVE scope(id) AS (SELECT ? UNION ALL SELECT g.id FROM media_groups g JOIN scope s ON g.parent_id = s.id) '
			: '';
		const scopeParams: Array<string | number> = query.parentId ? [query.parentId] : [];
		const conditions = ['i.library_id = ?'];
		const conditionParams: Array<string | number> = [libraryId];
		if (query.parentId) {
			conditions.push('i.group_id IN (SELECT id FROM scope)');
		}
		const library = this.db.$client
			.prepare('SELECT type_key AS typeKey FROM libraries WHERE id = ?')
			.get(libraryId) as { typeKey: string } | undefined;
		const joins
			= 'LEFT JOIN media_groups g ON g.id = i.group_id LEFT JOIN media_groups parent ON parent.id = g.parent_id';
		const applySearch = (forceLike: boolean): { where: string; allParams: Array<string | number> } => {
			const search = itemSearchPredicate(query.search, {
				libraryId,
				includeMusic: library?.typeKey === 'music-videos',
				forceLike,
			});
			return {
				where: [...conditions, search.sql].join(' AND '),
				allParams: [...scopeParams, ...conditionParams, ...search.params],
			};
		};
		let { where, allParams } = applySearch(false);
		let totalEntries = (
			this.db.$client
				.prepare(`${scopeCte}SELECT COUNT(*) AS count FROM media_items i ${joins} WHERE ${where}`)
				.get(...allParams) as { count: number }
		).count;
		if (ftsMatchQuery(query.search) && totalEntries === 0) {
			({ where, allParams } = applySearch(true));
			totalEntries = (
				this.db.$client
					.prepare(`${scopeCte}SELECT COUNT(*) AS count FROM media_items i ${joins} WHERE ${where}`)
					.get(...allParams) as { count: number }
			).count;
		}

		// Page matching media and retain hierarchy labels for match explanations.
		const offset = (query.page - 1) * query.pageSize;
		const rows = this.db.$client
			.prepare(
				`${scopeCte}SELECT i.id, i.library_id AS libraryId, i.group_id AS groupId,
          i.stable_key AS stableKey, i.kind, i.title, i.sort_title AS sortTitle,
          i.relative_path AS relativePath, i.playback_path AS playbackPath, i.plot, i.year,
          i.duration_milliseconds / 1000.0 AS durationSeconds, i.season_number AS seasonNumber,
          i.episode_number AS episodeNumber, i.metadata_status AS metadataStatus,
		  i.episode_end_number AS episodeEndNumber, i.edition, i.external_ids AS externalIds,
		  i.track_number AS trackNumber, i.disc_number AS discNumber, i.artists,
		  i.multipart_status AS multipartStatus, i.parts, i.subtitle_tracks AS subtitleTracks,
          i.availability, i.last_observed_at AS lastObservedAt, i.metadata,
          i.artwork_relative_path AS artworkRelativePath, i.fingerprint,
          i.file_modified_at AS fileModifiedAt, i.date_added_at AS dateAddedAt,
          i.title_bucket AS titleBucket, i.created_at AS createdAt, i.updated_at AS updatedAt,
          g.title AS groupTitle, g.kind AS groupKind,
          parent.title AS parentTitle, parent.kind AS parentKind
        FROM media_items i ${joins} WHERE ${where}
        ORDER BY i.sort_title COLLATE NOCASE ASC, i.id ASC LIMIT ? OFFSET ?`,
			)
			.all(...allParams, query.pageSize, offset) as Array<
				RawItemRow & {
					groupTitle: string | null;
					groupKind: MediaGroup['kind'] | null;
					parentTitle: string | null;
					parentKind: MediaGroup['kind'] | null;
				}
		>;

		// Resolve and attach the fields that caused each item to match.
		const matches = itemSourceMatches(this.db, rows, rawPattern, normalizedPattern, genrePattern);
		const entries = rows.map((row) => {
			const item = mappedItem(row);
			return {
				key: item.id,
				kind: 'item' as const,
				navigationKey: item.titleBucket,
				sectionKey: null,
				sectionLabel: null,
				item,
				group: null,
				matches: matches.get(item.id) ?? [],
			};
		});
		return {
			entries,
			pagination: {
				page: query.page,
				pageSize: query.pageSize,
				totalEntries,
				totalPages: Math.max(1, Math.ceil(totalEntries / query.pageSize)),
			},
		};
	}


	/** Browse shows or seasons available to a grouped program source. */
	private browseGroupSourceOptions(
		libraryId: string,
		query: MediaSourcePickerQuery,
	): MediaSourcePickerResult {
		// Search group labels and descendant item metadata within the requested hierarchy level.
		const rawPattern = `%${escapeLike(query.search)}%`;
		const normalizedPattern = `%${escapeLike(normalizeSearchText(query.search))}%`;
		const normalizedGenre = normalizeGenre(query.search);
		const genrePattern = `%${escapeLike(normalizedGenre?.key ?? normalizeSearchText(query.search))}%`;
		const conditions = ['g.library_id = ?'];
		const params: Array<string | number> = [libraryId];
		if (query.parentId) {
			conditions.push('g.parent_id = ?');
			params.push(query.parentId);
		}
		if (!query.parentId && !query.search) {
			conditions.push('g.parent_id IS NULL');
		}
		if (query.search) {
			conditions.push(`(
        g.title LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR parent.title LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR EXISTS (
          SELECT 1 FROM media_items gi
          LEFT JOIN media_groups owner ON owner.id = gi.group_id
          WHERE gi.library_id = g.library_id
            AND (owner.id = g.id OR owner.parent_id = g.id)
            AND EXISTS (
              SELECT 1 FROM media_item_genres gmg
              WHERE gmg.item_id = gi.id
                AND (gmg.genre_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR gmg.genre_key LIKE ? ESCAPE '\\' COLLATE NOCASE)
            )
        )
        OR EXISTS (
          SELECT 1 FROM media_items pi
          LEFT JOIN media_groups owner ON owner.id = pi.group_id
          WHERE pi.library_id = g.library_id
            AND (owner.id = g.id OR owner.parent_id = g.id)
            AND EXISTS (
              SELECT 1 FROM media_item_people gmp
              WHERE gmp.item_id = pi.id AND gmp.normalized_name LIKE ? ESCAPE '\\'
            )
        )
      )`);
			params.push(rawPattern, rawPattern, rawPattern, genrePattern, normalizedPattern);
		}
		const where = conditions.join(' AND ');
		const joins = 'LEFT JOIN media_groups parent ON parent.id = g.parent_id';
		const totalEntries = (
			this.db.$client
				.prepare(`SELECT COUNT(*) AS count FROM media_groups g ${joins} WHERE ${where}`)
				.get(...params) as { count: number }
		).count;

		// Page matching groups and attach the metadata fields that matched the search.
		const offset = (query.page - 1) * query.pageSize;
		const rows = this.db.$client
			.prepare(
				`SELECT g.id, g.library_id AS libraryId, g.parent_id AS parentId, g.kind,
          g.title, g.sort_title AS sortTitle, g.year, g.plot, g.metadata,
          g.artwork_relative_path AS artworkRelativePath,
          parent.artwork_relative_path AS parentArtworkRelativePath, parent.metadata AS parentMetadata,
          (SELECT COUNT(*) FROM media_groups child WHERE child.parent_id = g.id) +
            (SELECT COUNT(*) FROM media_items child_item WHERE child_item.group_id = g.id) AS childCount,
          parent.title AS parentTitle, parent.kind AS parentKind
        FROM media_groups g ${joins} WHERE ${where}
        ORDER BY g.sort_title COLLATE NOCASE ASC, g.id ASC LIMIT ? OFFSET ?`,
			)
			.all(...params, query.pageSize, offset) as RawGroupRow[];
		const matches = query.search
			? this.groupSourceMatches(rows, rawPattern, normalizedPattern, genrePattern)
			: new Map<string, MediaSourceMatch[]>();
		const entries: MediaSourcePickerEntry[] = rows.map((row) => {
			const group = mappedGroup(row);
			return {
				key: group.id,
				kind: 'group',
				navigationKey: '',
				sectionKey: null,
				sectionLabel: null,
				item: null,
				group,
				matches: matches.get(group.id) ?? [],
			};
		});
		return {
			entries,
			pagination: {
				page: query.page,
				pageSize: query.pageSize,
				totalEntries,
				totalPages: Math.max(1, Math.ceil(totalEntries / query.pageSize)),
			},
		};
	}

	/** Report whether group source matches. */
	private groupSourceMatches(
		rows: RawGroupRow[],
		rawPattern: string,
		normalizedPattern: string,
		genrePattern: string,
	): Map<string, MediaSourceMatch[]> {
		const matches = new Map<string, MediaSourceMatch[]>();
		const rawSearch = rawPattern
			.slice(1, -1)
			.replace(/\\([\\%_])/g, '$1')
			.toLocaleLowerCase();
		for (const row of rows) {
			if (row.title.toLocaleLowerCase().includes(rawSearch)) {
				addSourceMatch(matches, row.id, { field: 'title', label: row.title });
			}
			if (row.parentTitle?.toLocaleLowerCase().includes(rawSearch) && row.parentKind) {
				addSourceMatch(matches, row.id, { field: row.parentKind, label: row.parentTitle });
			}
		}
		const ids = rows.map((row) => row.id);
		if (ids.length === 0) {
			return matches;
		}

		const placeholders = ids.map(() => '?').join(', ');
		const genreRows = this.db.$client
			.prepare(
				`SELECT target.id AS targetId, mg.genre_name AS label
        FROM media_groups target
        JOIN media_groups owner ON owner.id = target.id OR owner.parent_id = target.id
        JOIN media_items i ON i.group_id = owner.id
        JOIN media_item_genres mg ON mg.item_id = i.id
        WHERE target.id IN (${placeholders})
          AND (mg.genre_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR mg.genre_key LIKE ? ESCAPE '\\' COLLATE NOCASE)
        GROUP BY target.id, mg.genre_key, mg.genre_name
        ORDER BY mg.genre_name COLLATE NOCASE`,
			)
			.all(...ids, rawPattern, genrePattern) as Array<{ targetId: string; label: string }>;
		for (const row of genreRows) {
			addSourceMatch(matches, row.targetId, { field: 'genre', label: row.label });
		}
		const peopleRows = this.db.$client
			.prepare(
				`SELECT target.id AS targetId, mp.person_type AS field, mp.name AS label
        FROM media_groups target
        JOIN media_groups owner ON owner.id = target.id OR owner.parent_id = target.id
        JOIN media_items i ON i.group_id = owner.id
        JOIN media_item_people mp ON mp.item_id = i.id
        WHERE target.id IN (${placeholders}) AND mp.normalized_name LIKE ? ESCAPE '\\'
        GROUP BY target.id, mp.person_type, mp.normalized_name, mp.name
        ORDER BY mp.name COLLATE NOCASE`,
			)
			.all(...ids, normalizedPattern) as Array<{
			targetId: string;
			field: 'actor' | 'director';
			label: string;
		}>;
		for (const row of peopleRows) {
			addSourceMatch(matches, row.targetId, { field: row.field, label: row.label });
		}
		return matches;
	}

	/** Calculate the first page associated with each catalog navigation anchor. */
	private navigationWithPages(
		rows: Array<{ key: string; label: string; count: number }>,
		pageSize: number,
	): MediaBrowseResult['navigation'] {
		let seen = 0;
		return rows.map((row) => {
			const result = { ...row, firstPage: Math.floor(seen / pageSize) + 1 };
			seen += row.count;
			return result;
		});
	}

	/** List genre facets with optional counts for required and disallowed Match all actions. */
	async listMediaGenres(
		libraryId: string,
		selection: MediaGenreFacetSelection | null = null,
	): Promise<MediaGenreFacet[]> {
		return this.assets.listMediaGenres(libraryId, selection);
	}

	/** Resolve selected media in request order with canonical or authored response identifiers. */
	async listMediaItemsByIds(
		libraryId: string,
		itemIds: string[],
		identity: 'canonical' | 'requested' = 'canonical',
	): Promise<MediaItem[]> {
		return this.assets.listMediaItemsByIds(libraryId, itemIds, identity);
	}

	/** Collect the stable identifiers for list media groups by. */
	async listMediaGroupsByIds(libraryId: string, groupIds: string[]): Promise<MediaGroup[]> {
		return this.assets.listMediaGroupsByIds(libraryId, groupIds);
	}

	/** Return a media item's full catalog detail, if it still exists. */
	async getMediaItem(id: string): Promise<MediaItemDetail | null> {
		return this.assets.getMediaItem(id);
	}

	/** Return bounded indexed metadata for a compact media-card preview. */
	async getMediaCardPreview(id: string): Promise<MediaCardPreview | null> {
		return this.assets.getMediaCardPreview(id);
	}

	/** Return bounded recently indexed media grouped for every library overview row. */
	listLibraryContentPreviews(): LibraryContentPreview[] {
		return this.assets.listLibraryContentPreviews();
	}

	/** Return the library source location that owns a media item. */
	async getMediaFileOwner(id: string): Promise<MediaFileOwner | null> {
		return this.assets.getMediaFileOwner(id);
	}

	/** Return the source artwork location for a catalog item or group. */
	async getArtworkOwner(kind: 'items' | 'groups', id: string, role?: 'poster' | 'landscape' | 'fanart') {
		return this.assets.getArtworkOwner(kind, id, role);
	}
}
