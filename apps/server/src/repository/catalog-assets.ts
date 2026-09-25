import { normalizeGenre } from '../scanner/catalog-metadata.js';
import { listGenreFacets } from './genre-facets.js';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type {
	LibraryContentPreview,
	MediaGenreFacet,
	MediaGroup,
	MediaGroupKind,
	MediaCardPreview,
	MediaItem,
	MediaItemDetail,
} from '@moirai/shared';
import { MAX_LIBRARY_CONTENT_PREVIEW_ITEMS } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import {
	libraries,
	mediaGroups,
	mediaItemAliases,
	mediaItemGenres,
	mediaItemPeople,
	mediaItems,
} from '../db/schema.js';
import type {
	MediaFileOwner,
	MediaGenreFacetSelection,
	MediaProbeCacheEntry,
} from './contracts.js';
import {
	artworkUrl,
	cacheVersion,
	decodedMetadata,
	mappedGroup,
	mappedItem,
	metadataNumber,
	metadataResolution,
	metadataString,
	metadataStrings,
	technicalCodecs,
} from './catalog-records.js';
import type { RawGroupRow, RawItemRow } from './catalog-records.js';

/** Raw row returned by the bounded library-overview carousel query. */
interface RawLibraryContentPreviewRow {
	libraryId: string;
	itemId: string | null;
	title: string | null;
	year: number | null;
	availability: MediaItem['availability'] | null;
	metadata: string | Record<string, unknown> | null;
	artworkRelativePath: string | null;
	fingerprint: string | null;
}

/**
 * Own catalog lookups that do not participate in paginated browsing. This repository resolves
 * compatibility aliases and retrieves probe, artwork-owner, group, and item detail records without
 * coupling those queries to browse result construction.
 */
export class CatalogAssetsRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** Resolve a compatibility alias while preferring a current item with the requested ID. */
	private async canonicalItemId(id: string): Promise<string> {
		const [direct] = await this.db.select({ id: mediaItems.id }).from(mediaItems)
			.where(eq(mediaItems.id, id));
		if (direct) {
			return id;
		}

		const [alias] = await this.db.select({ itemId: mediaItemAliases.itemId })
			.from(mediaItemAliases)
			.where(eq(mediaItemAliases.aliasId, id));
		return alias?.itemId ?? id;
	}

	/** Return cached probe facts for every indexed item in one library. */
	async listMediaProbeCache(libraryId: string): Promise<MediaProbeCacheEntry[]> {
		const rows = await this.db
			.select({
				relativePath: mediaItems.relativePath,
				probeFingerprint: mediaItems.probeFingerprint,
				durationMilliseconds: mediaItems.durationMilliseconds,
				probeStatus: mediaItems.probeStatus,
				probeUpdatedAt: mediaItems.probeUpdatedAt,
				probeErrorCode: mediaItems.probeErrorCode,
				technicalMetadata: mediaItems.technicalMetadata,
			})
			.from(mediaItems)
			.where(eq(mediaItems.libraryId, libraryId));
		return rows.map((row) => ({
			...row,
			technicalMetadata: row.technicalMetadata ?? {},
		}));
	}

	/** Return whether a library contains media without a successful technical probe. */
	async libraryNeedsMediaProbe(libraryId: string): Promise<boolean> {
		const [row] = await this.db
			.select({ id: mediaItems.id })
			.from(mediaItems)
			.where(and(eq(mediaItems.libraryId, libraryId), ne(mediaItems.probeStatus, 'complete')))
			.limit(1);
		return Boolean(row);
	}

	/** Collect the stable identifiers for existing artwork owners. */
	async existingArtworkOwnerIds(
		libraryId: string,
		kind: 'items' | 'groups',
		ids: string[],
	): Promise<Set<string>> {
		if (ids.length === 0) {
			return new Set();
		}

		const table = kind === 'items' ? mediaItems : mediaGroups;
		const rows = await this.db
			.select({ id: table.id })
			.from(table)
			.where(and(eq(table.libraryId, libraryId), inArray(table.id, ids)));
		return new Set(rows.map((row) => row.id));
	}

	/**
	 * List every normalized genre in one library. A contextual selection returns the result counts
	 * for making each genre primary, required, or disallowed while treating that genre's prior rule as neutral.
	 */
	async listMediaGenres(
		libraryId: string,
		selection: MediaGenreFacetSelection | null = null,
	): Promise<MediaGenreFacet[]> {
		return listGenreFacets(this.db.$client, libraryId, selection);
	}

	/** Return selected media in request order using canonical or authored response identifiers. */
	async listMediaItemsByIds(
		libraryId: string,
		itemIds: string[],
		identity: 'canonical' | 'requested' = 'canonical',
	): Promise<MediaItem[]> {
		if (itemIds.length === 0) {
			return [];
		}

		const aliases = await this.db.select({ aliasId: mediaItemAliases.aliasId, itemId: mediaItemAliases.itemId })
			.from(mediaItemAliases)
			.where(inArray(mediaItemAliases.aliasId, itemIds));
		const aliasMap = new Map(aliases.map((alias) => [alias.aliasId, alias.itemId]));
		const canonicalIds = itemIds.map((id) => aliasMap.get(id) ?? id);
		const rows = await this.db
			.select()
			.from(mediaItems)
			.where(and(eq(mediaItems.libraryId, libraryId), inArray(mediaItems.id, canonicalIds)));
		const byId = new Map(rows.map((row) => [row.id, mappedItem(row as unknown as RawItemRow)]));
		return canonicalIds.flatMap((canonicalId, index) => {
			const item = byId.get(canonicalId);
			return item
				? [{ ...item, id: identity === 'requested' ? itemIds[index]! : item.id }]
				: [];
		});
	}

	/** Return selected media groups in the caller's requested order. */
	async listMediaGroupsByIds(libraryId: string, groupIds: string[]): Promise<MediaGroup[]> {
		if (groupIds.length === 0) {
			return [];
		}

		const placeholders = groupIds.map(() => '?').join(', ');
		const rows = this.db.$client
			.prepare(
				`SELECT g.id, g.library_id AS libraryId, g.parent_id AS parentId, g.kind,
          g.title, g.sort_title AS sortTitle, g.year, g.plot, g.metadata,
          g.artwork_relative_path AS artworkRelativePath,
          parent.artwork_relative_path AS parentArtworkRelativePath, parent.metadata AS parentMetadata,
          (SELECT COUNT(*) FROM media_groups child WHERE child.parent_id = g.id) +
            (SELECT COUNT(*) FROM media_items child_item WHERE child_item.group_id = g.id) AS childCount
        FROM media_groups g LEFT JOIN media_groups parent ON parent.id = g.parent_id AND parent.library_id = g.library_id
        WHERE g.library_id = ? AND g.id IN (${placeholders})`,
			)
			.all(libraryId, ...groupIds) as RawGroupRow[];
		const byId = new Map(rows.map((row) => [row.id, mappedGroup(row)]));
		return groupIds.flatMap((id) => {
			const group = byId.get(id);
			return group ? [group] : [];
		});
	}

	/** Return a media item's full catalog detail, if it still exists. */
	async getMediaItem(id: string): Promise<MediaItemDetail | null> {
		const canonicalId = await this.canonicalItemId(id);
		const [row] = await this.db.select().from(mediaItems).where(eq(mediaItems.id, canonicalId));
		if (!row) {
			return null;
		}

		const genres = await this.db
			.select({ name: mediaItemGenres.genreName })
			.from(mediaItemGenres)
			.where(eq(mediaItemGenres.itemId, canonicalId))
			.orderBy(asc(mediaItemGenres.genreName));
		const people = await this.db
			.select()
			.from(mediaItemPeople)
			.where(eq(mediaItemPeople.itemId, canonicalId))
			.orderBy(
				asc(sql<number>`${mediaItemPeople.sortOrder} IS NULL`),
				asc(mediaItemPeople.sortOrder),
				asc(mediaItemPeople.name),
			);
		const groupTrail = row.groupId
			? (this.db.$client
				.prepare(
					'WITH RECURSIVE trail(id, parent_id, kind, title, depth) AS (SELECT id, parent_id, kind, title, 0 FROM media_groups WHERE id = ? UNION ALL SELECT g.id, g.parent_id, g.kind, g.title, t.depth + 1 FROM media_groups g JOIN trail t ON t.parent_id = g.id) SELECT id, kind, title FROM trail ORDER BY depth DESC',
				)
				.all(row.groupId) as Array<{ id: string; kind: MediaGroupKind; title: string }>)
			: [];
		const item = mappedItem(row as unknown as RawItemRow);
		const technical = row.technicalMetadata ?? {};
		return {
			...item,
			genres: genres.map((genre) => genre.name),
			directors: people
				.filter((person) => person.personType === 'director')
				.map((person) => person.name),
			actors: people
				.filter((person) => person.personType === 'actor')
				.map(({ name, role, sortOrder }) => ({ name, role, sortOrder })),
			writers: metadataStrings(item.metadata, 'writers'),
			studios: metadataStrings(item.metadata, 'studio'),
			countries: metadataStrings(item.metadata, 'countries'),
			certification: metadataString(item.metadata, 'certification'),
			rating: metadataNumber(item.metadata, 'rating'),
			resolution: metadataResolution(technical),
			fileSizeBytes: typeof technical.fileSizeBytes === 'number'
				? technical.fileSizeBytes
				: null,
			container: typeof technical.container === 'string' ? technical.container : null,
			videoCodecs: technicalCodecs(technical, 'video'),
			audioCodecs: technicalCodecs(technical, 'audio'),
			probeStatus: row.probeStatus,
			probeUpdatedAt: row.probeUpdatedAt,
			probeErrorCode: row.probeErrorCode,
			groupTrail,
		};
	}

	/** Return bounded indexed metadata for a compact media-card preview. */
	async getMediaCardPreview(id: string): Promise<MediaCardPreview | null> {
		const canonicalId = await this.canonicalItemId(id);
		const [row] = await this.db
			.select({
				id: mediaItems.id,
				primaryGenreKey: mediaItems.primaryGenreKey,
				primaryGenre: sql<string | null>`(SELECT genre_name FROM media_item_genres
					WHERE item_id = ${mediaItems.id} AND genre_key = ${mediaItems.primaryGenreKey} LIMIT 1)`,
				title: mediaItems.title,
				year: mediaItems.year,
				plot: mediaItems.plot,
				metadata: mediaItems.metadata,
				artworkRelativePath: mediaItems.artworkRelativePath,
				fingerprint: mediaItems.fingerprint,
			})
			.from(mediaItems)
			.where(eq(mediaItems.id, canonicalId));
		if (!row) {
			return null;
		}

		const actors = await this.db
			.select({ name: mediaItemPeople.name })
			.from(mediaItemPeople)
			.where(and(
				eq(mediaItemPeople.itemId, canonicalId),
				eq(mediaItemPeople.personType, 'actor'),
			))
			.orderBy(
				asc(sql<number>`${mediaItemPeople.sortOrder} IS NULL`),
				asc(mediaItemPeople.sortOrder),
				asc(mediaItemPeople.name),
			)
			.limit(3);

		return {
			id: row.id,
			title: row.title,
			year: row.year,
			plot: row.plot,
			artworkUrl: artworkUrl(
				'items',
				row.id,
				row.artworkRelativePath,
				cacheVersion(row.metadata, row.fingerprint),
			),
			rating: metadataNumber(row.metadata, 'rating'),
			primaryGenre: metadataStrings(row.metadata, 'genres')
				.find((genre) => normalizeGenre(genre)?.key === row.primaryGenreKey) ?? row.primaryGenre,
			actors: actors.map((actor) => actor.name),
		};
	}

	/** Return one bounded recently indexed media carousel for every configured library. */
	listLibraryContentPreviews(): LibraryContentPreview[] {
		const rows = this.db.$client.prepare(
			`WITH ranked_items AS (
				SELECT i.id, i.library_id, i.title, i.year, i.availability, i.metadata,
					i.artwork_relative_path, i.fingerprint,
					row_number() OVER (
						PARTITION BY i.library_id
						ORDER BY i.date_added_at DESC, i.sort_title COLLATE NOCASE ASC, i.id ASC
					) AS preview_rank
				FROM media_items i
			)
			SELECT l.id AS libraryId, ranked.id AS itemId, ranked.title, ranked.year,
				ranked.availability, ranked.metadata,
				ranked.artwork_relative_path AS artworkRelativePath,
				ranked.fingerprint
			FROM libraries l
			LEFT JOIN ranked_items ranked
				ON ranked.library_id = l.id AND ranked.preview_rank <= ?
			ORDER BY l.name COLLATE NOCASE ASC, l.id ASC, ranked.preview_rank ASC`,
		).all(MAX_LIBRARY_CONTENT_PREVIEW_ITEMS) as RawLibraryContentPreviewRow[];
		const previews = new Map<string, LibraryContentPreview>();
		for (const row of rows) {
			const preview = previews.get(row.libraryId) ?? { libraryId: row.libraryId, items: [] };
			if (
				row.itemId
				&& row.title
				&& row.availability
				&& row.metadata
				&& row.fingerprint
			) {
				const metadata = decodedMetadata(row.metadata);
				preview.items.push({
					id: row.itemId,
					title: row.title,
					year: row.year,
					artworkUrl: artworkUrl(
						'items',
						row.itemId,
						row.artworkRelativePath,
						cacheVersion(metadata, row.fingerprint),
					),
					availability: row.availability,
				});
			}
			previews.set(row.libraryId, preview);
		}

		return [...previews.values()];
	}

	/** Return the library source location that owns a media item. */
	async getMediaFileOwner(id: string): Promise<MediaFileOwner | null> {
		const canonicalId = await this.canonicalItemId(id);
		const [row] = await this.db
			.select({
				libraryId: mediaItems.libraryId,
				relativePath: mediaItems.relativePath,
				sourceType: libraries.sourceType,
				sourceConfig: libraries.sourceConfig,
			})
			.from(mediaItems)
			.innerJoin(libraries, eq(mediaItems.libraryId, libraries.id))
			.where(eq(mediaItems.id, canonicalId));
		return row
			? {
				libraryId: row.libraryId,
				relativePath: row.relativePath,
				sourceType: row.sourceType,
				scanRoot: row.sourceConfig.scanRoot,
			}
			: null;
	}

	/** Return the source artwork location for a catalog item or group. */
	async getArtworkOwner(kind: 'items' | 'groups', id: string, role?: 'poster' | 'landscape' | 'fanart') {
		if (kind === 'items') {
			const canonicalId = await this.canonicalItemId(id);
			const [row] = await this.db
				.select({
					libraryId: mediaItems.libraryId,
					relativePath: mediaItems.artworkRelativePath,
					posterRelativePath: mediaItems.posterRelativePath,
					landscapeRelativePath: mediaItems.landscapeRelativePath,
					fanartRelativePath: mediaItems.fanartRelativePath,
					metadata: mediaItems.metadata,
					fallbackVersion: mediaItems.fingerprint,
				})
				.from(mediaItems)
				.where(eq(mediaItems.id, canonicalId));
			return row
				? {
					libraryId: row.libraryId,
					relativePath: role === 'poster'
						? row.posterRelativePath ?? row.relativePath
						: role === 'landscape'
							? row.landscapeRelativePath
							: role === 'fanart'
								? row.fanartRelativePath
								: row.relativePath,
					cacheVersion: cacheVersion(row.metadata, row.fallbackVersion),
				}
				: null;
		}

		const [row] = await this.db
			.select({
				libraryId: mediaGroups.libraryId,
				relativePath: mediaGroups.artworkRelativePath,
				posterRelativePath: mediaGroups.posterRelativePath,
				landscapeRelativePath: mediaGroups.landscapeRelativePath,
				fanartRelativePath: mediaGroups.fanartRelativePath,
				metadata: mediaGroups.metadata,
			})
			.from(mediaGroups)
			.where(eq(mediaGroups.id, id));
		return row
			? {
				libraryId: row.libraryId,
				relativePath: role === 'poster'
					? row.posterRelativePath ?? row.relativePath
					: role === 'landscape'
						? row.landscapeRelativePath
						: role === 'fanart'
							? row.fanartRelativePath
							: row.relativePath,
				cacheVersion: cacheVersion(row.metadata, row.relativePath ?? id),
			}
			: null;
	}
}
