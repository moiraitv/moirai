import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type {
	MediaGenreFacet,
	MediaGroup,
	MediaGroupKind,
	MediaItem,
	MediaItemDetail,
} from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import {
	libraries,
	mediaGroups,
	mediaItemAliases,
	mediaItemGenres,
	mediaItemPeople,
	mediaItems,
} from '../db/schema.js';
import type { MediaFileOwner, MediaProbeCacheEntry } from './contracts.js';
import {
	cacheVersion,
	mappedGroup,
	mappedItem,
	metadataNumber,
	metadataResolution,
	metadataString,
	metadataStrings,
	technicalCodecs,
} from './catalog-records.js';
import type { RawGroupRow, RawItemRow } from './catalog-records.js';

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

	/** List normalized genre facets present in one library. */
	async listMediaGenres(libraryId: string): Promise<MediaGenreFacet[]> {
		return this.db.$client
			.prepare(
				'SELECT genre_key AS key, genre_name AS name, COUNT(*) AS count FROM media_item_genres WHERE library_id = ? GROUP BY genre_key, genre_name ORDER BY genre_name COLLATE NOCASE',
			)
			.all(libraryId) as MediaGenreFacet[];
	}

	/** Return selected media items in the caller's requested order. */
	async listMediaItemsByIds(libraryId: string, itemIds: string[]): Promise<MediaItem[]> {
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
		return canonicalIds.flatMap((id) => {
			const item = byId.get(id);
			return item ? [item] : [];
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
          (SELECT COUNT(*) FROM media_groups child WHERE child.parent_id = g.id) +
            (SELECT COUNT(*) FROM media_items child_item WHERE child_item.group_id = g.id) AS childCount
        FROM media_groups g
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
			.orderBy(asc(mediaItemPeople.sortOrder), asc(mediaItemPeople.name));
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
	async getArtworkOwner(kind: 'items' | 'groups', id: string) {
		if (kind === 'items') {
			const canonicalId = await this.canonicalItemId(id);
			const [row] = await this.db
				.select({
					libraryId: mediaItems.libraryId,
					relativePath: mediaItems.artworkRelativePath,
					metadata: mediaItems.metadata,
					fallbackVersion: mediaItems.fingerprint,
				})
				.from(mediaItems)
				.where(eq(mediaItems.id, canonicalId));
			return row
				? {
					libraryId: row.libraryId,
					relativePath: row.relativePath,
					cacheVersion: cacheVersion(row.metadata, row.fallbackVersion),
				}
				: null;
		}

		const [row] = await this.db
			.select({
				libraryId: mediaGroups.libraryId,
				relativePath: mediaGroups.artworkRelativePath,
				metadata: mediaGroups.metadata,
			})
			.from(mediaGroups)
			.where(eq(mediaGroups.id, id));
		return row
			? {
				libraryId: row.libraryId,
				relativePath: row.relativePath,
				cacheVersion: cacheVersion(row.metadata, row.relativePath ?? id),
			}
			: null;
	}
}
