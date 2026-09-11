import { and, asc, eq, gt, inArray, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type {
	ChannelTimelineMaterializationStatus,
	SchedulableMedia,
	SchedulingCatalog,
	SchedulingProgram,
	SelectionStateRecord,
} from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import {
	libraries,
	mediaGroups,
	mediaItemAliases,
	mediaItemGenres,
	mediaItems,
	materializedTimelineSegments,
	selectionStates,
	timelineMaterializations,
} from '../db/schema.js';
import { indexSchedulingCatalog, schedulingCatalogScope } from '../scheduling/catalog.js';
import type {
	MaterializedSegmentRecord,
	TimelineCommit,
	TimelineMaterializationRecord,
} from './contracts.js';
import {
	artworkUrl,
	cacheVersion,
	decodedMetadata,
	metadataNumber,
	metadataPersonNames,
	metadataReleaseDate,
	metadataStrings,
} from './catalog.js';
import { SchedulingConfigurationRepository } from './scheduling-config.js';

/** Bound multi-row timeline writes below SQLite statement parameter limits. */
const TIMELINE_COMMIT_BATCH_SIZE = 500;

/** Internal marker for a failed channel that has never committed a timeline. */
const UNCOMMITTED_FAILURE_FINGERPRINT = 'uncommitted-failure';

/** Convert a timeline row into its public health representation. */
function publicMaterializationStatus(
	row: typeof timelineMaterializations.$inferSelect,
): ChannelTimelineMaterializationStatus {
	const hasCommit = row.inputFingerprint !== UNCOMMITTED_FAILURE_FINGERPRINT;
	return {
		channelId: row.channelId,
		health: row.status,
		windowStart: hasCommit ? row.windowStart : null,
		windowEnd: hasCommit ? row.windowEnd : null,
		committedAt: hasCommit ? row.committedAt : null,
		pendingSince: row.pendingSince,
		applyAfter: row.applyAfter,
		lastError: row.lastError,
	};
}

/** Reconstruct a committed segment with its captured media and cursor snapshots. */
function materializedSegmentRecord(
	row: typeof materializedTimelineSegments.$inferSelect,
): MaterializedSegmentRecord {
	return {
		segment: {
			id: row.id,
			role: row.role,
			channelId: row.channelId,
			scheduleLayerId: row.scheduleLayerId,
			templateId: row.templateId,
			slotId: row.slotId,
			programId: row.programId,
			programAncestry: row.programAncestry,
			mediaItemId: row.mediaItemId,
			title: row.title,
			playbackPath: row.playbackPath,
			playbackParts: row.playbackParts.length > 0
				? row.playbackParts
				: row.playbackPath
					? [{
						playbackPath: row.playbackPath,
						durationSeconds: row.sourceFinishSeconds ?? 0,
					}]
					: [],
			start: row.startsAt,
			finish: row.finishesAt,
			sourceStartSeconds: row.sourceStartSeconds,
			sourceFinishSeconds: row.sourceFinishSeconds,
			truncated: row.truncated,
		},
		mediaSnapshot: row.mediaSnapshot as SchedulableMedia | null,
		stateDelta: row.stateDelta,
		continuation: row.continuation,
	};
}

/**
 * Own durable scheduling execution state alongside authored scheduling configuration. This repository
 * adds scoped catalog caching, playback cursors, materialization health, and atomic timeline commits
 * to the configuration operations inherited from its base.
 */
export class SchedulingRepository extends SchedulingConfigurationRepository {
	private schedulingCatalogRevision = 0;
	private readonly schedulingCatalogCache = new Map<
		string,
		{ revision: number; value: Promise<SchedulingCatalog> }
	>();

	constructor(db: MoiraiDatabase) {
		super(db);
	}

	/** Invalidate scoped scheduling catalogs after index or source-health changes. */
	invalidateSchedulingCatalog(): void {
		this.schedulingCatalogRevision += 1;
		this.schedulingCatalogCache.clear();
	}

	/** Load and cache the catalog subset referenced by the supplied programs. */
	async getSchedulingCatalog(
		programs?: SchedulingProgram[],
		rootProgramIds?: Iterable<string>,
	): Promise<SchedulingCatalog> {
		const scopedPrograms = programs ?? (await this.listPrograms());
		const scope = schedulingCatalogScope(scopedPrograms, rootProgramIds);
		const key = JSON.stringify(scope);
		const cached = this.schedulingCatalogCache.get(key);
		if (cached?.revision === this.schedulingCatalogRevision) {
			return cached.value;
		}

		const revision = this.schedulingCatalogRevision;
		const value = this.loadSchedulingCatalog(scope).then((catalog) => ({
			...catalog,
			cacheKey: `${revision}:${key}`,
		}));
		this.schedulingCatalogCache.set(key, { revision: this.schedulingCatalogRevision, value });
		void value.catch(() => {
			if (this.schedulingCatalogCache.get(key)?.value === value) {
				this.schedulingCatalogCache.delete(key);
			}
		});
		while (this.schedulingCatalogCache.size > 32) {
			this.schedulingCatalogCache.delete(this.schedulingCatalogCache.keys().next().value!);
		}
		return value;
	}

	/** Query only the libraries, groups, and media needed by the requested scheduling scope. */
	private async loadSchedulingCatalog(
		scope: ReturnType<typeof schedulingCatalogScope>,
	): Promise<SchedulingCatalog> {
		const aliases = scope.itemIds.length > 0
			? await this.db.select({ aliasId: mediaItemAliases.aliasId, itemId: mediaItemAliases.itemId })
				.from(mediaItemAliases)
				.where(sql`${mediaItemAliases.aliasId} IN (SELECT value FROM json_each(${JSON.stringify(scope.itemIds)}))`)
			: [];
		const mediaAliases = Object.fromEntries(aliases.map((alias) => [alias.aliasId, alias.itemId]));
		const scopedItemIds = scope.itemIds.map((id) => mediaAliases[id] ?? id);

		// Resolve referenced groups to the libraries that own their media.
		const referencedGroups
			= scope.groupIds.length > 0
				? await this.db
					.select({ id: mediaGroups.id, libraryId: mediaGroups.libraryId })
					.from(mediaGroups)
					.where(
						sql`${mediaGroups.id} IN (SELECT value FROM json_each(${JSON.stringify(scope.groupIds)}))`,
					)
				: [];
		const groupLibraryIds = new Set(referencedGroups.map((group) => group.libraryId));
		const fullMediaLibraryIds = new Set(scope.libraryIds);
		const scopedLibraryIds = new Set([
			...scope.sourceLibraryIds,
			...fullMediaLibraryIds,
			...groupLibraryIds,
		]);

		// Load selected group descendants and their ancestors for source matching and labels.
		const relatedGroupRows
			= scope.groupIds.length > 0
				? (this.db.$client
					.prepare(
						`WITH RECURSIVE
                selected(id) AS (SELECT value FROM json_each(?)),
                descendants(id) AS (
                  SELECT id FROM selected
                  UNION
                  SELECT media_groups.id FROM media_groups
                  JOIN descendants ON media_groups.parent_id = descendants.id
                ),
                related(id) AS (
                  SELECT id FROM descendants
                  UNION
                  SELECT media_groups.parent_id FROM media_groups
                  JOIN related ON media_groups.id = related.id
                  WHERE media_groups.parent_id IS NOT NULL
                )
              SELECT DISTINCT media_groups.id, media_groups.parent_id AS parentId,
                media_groups.title, media_groups.kind
              FROM media_groups JOIN related ON related.id = media_groups.id`,
					)
					.all(JSON.stringify(scope.groupIds)) as Array<{
					id: string;
					parentId: string | null;
					title: string;
					kind: string;
				}>)
				: [];
		const relatedGroupIds = relatedGroupRows.map((group) => group.id);

		// Build one bounded media query across full libraries, explicit items, and group trees.
		const mediaConditions: SQL[] = [];
		if (fullMediaLibraryIds.size > 0) {
			mediaConditions.push(
				sql`${mediaItems.libraryId} IN (SELECT value FROM json_each(${JSON.stringify([...fullMediaLibraryIds])}))`,
			);
		}
		if (scopedItemIds.length > 0) {
			mediaConditions.push(
				sql`${mediaItems.id} IN (SELECT value FROM json_each(${JSON.stringify(scopedItemIds)}))`,
			);
		}
		if (relatedGroupIds.length > 0) {
			mediaConditions.push(
				sql`${mediaItems.groupId} IN (SELECT value FROM json_each(${JSON.stringify(relatedGroupIds)}))`,
			);
		}
		const items
			= mediaConditions.length > 0
				? await this.db
					.select({
						id: mediaItems.id,
						libraryId: mediaItems.libraryId,
						groupId: mediaItems.groupId,
						kind: mediaItems.kind,
						title: mediaItems.title,
						sortTitle: mediaItems.sortTitle,
						playbackPath: mediaItems.playbackPath,
						parts: mediaItems.parts,
						durationMilliseconds: mediaItems.durationMilliseconds,
						seasonNumber: mediaItems.seasonNumber,
						episodeNumber: mediaItems.episodeNumber,
						episodeEndNumber: mediaItems.episodeEndNumber,
						trackNumber: mediaItems.trackNumber,
						discNumber: mediaItems.discNumber,
						multipartStatus: mediaItems.multipartStatus,
						plot: mediaItems.plot,
						year: mediaItems.year,
						metadata: mediaItems.metadata,
						artworkRelativePath: mediaItems.artworkRelativePath,
						fingerprint: mediaItems.fingerprint,
						availability: mediaItems.availability,
						dateAddedAt: mediaItems.dateAddedAt,
					})
					.from(mediaItems)
					.where(or(...mediaConditions))
				: [];
		const itemIds = items.map((item) => item.id);
		for (const item of items) {
			scopedLibraryIds.add(item.libraryId);
		}

		// Load hierarchy for full-library sources and merge it with explicitly related groups.
		const libraryGroups
			= fullMediaLibraryIds.size > 0
				? await this.db
					.select({
						id: mediaGroups.id,
						parentId: mediaGroups.parentId,
						title: mediaGroups.title,
						kind: mediaGroups.kind,
					})
					.from(mediaGroups)
					.where(
						sql`${mediaGroups.libraryId} IN (SELECT value FROM json_each(${JSON.stringify([...fullMediaLibraryIds])}))`,
					)
				: [];
		const groups = [
			...new Map(
				[...libraryGroups, ...relatedGroupRows].map((group) => [group.id, group]),
			).values(),
		];
		const groupsById = new Map(groups.map((group) => [group.id, group]));
		/** Build a stable hierarchy key for sequential catalog ordering. */
		const groupSortKey = (groupId: string | null): string => {
			const names: string[] = [];
			const visited = new Set<string>();
			let current = groupId;
			while (current && !visited.has(current)) {
				visited.add(current);
				const group = groupsById.get(current);
				if (!group) {
					break;
				}
				names.unshift(group.title);
				current = group.parentId;
			}
			return names.join('\u0000');
		};

		// Load normalized genres and source health only for media in this catalog scope.
		const genres
			= itemIds.length > 0
				? await this.db
					.select({
						itemId: mediaItemGenres.itemId,
						key: mediaItemGenres.genreKey,
						name: mediaItemGenres.genreName,
					})
					.from(mediaItemGenres)
					.where(
						sql`${mediaItemGenres.itemId} IN (SELECT value FROM json_each(${JSON.stringify(itemIds)}))`,
					)
					.orderBy(asc(mediaItemGenres.itemId), asc(mediaItemGenres.genreName))
				: [];
		const sourceLibraries
			= scopedLibraryIds.size > 0
				? await this.db
					.select({
						id: libraries.id,
						name: libraries.name,
						enabled: libraries.enabled,
						sourceAvailability: libraries.sourceAvailability,
					})
					.from(libraries)
					.where(
						sql`${libraries.id} IN (SELECT value FROM json_each(${JSON.stringify([...scopedLibraryIds])}))`,
					)
				: [];
		const genreMap = new Map<string, string[]>();
		const genreNameMap = new Map<string, string[]>();
		for (const genre of genres) {
			genreMap.set(genre.itemId, [...(genreMap.get(genre.itemId) ?? []), genre.key]);
			genreNameMap.set(genre.itemId, [...(genreNameMap.get(genre.itemId) ?? []), genre.name]);
		}

		// Convert database rows into the indexed catalog consumed by the scheduling engine.
		return indexSchedulingCatalog({
			media: items.map((item) => {
				const metadata = decodedMetadata(item.metadata);
				return {
					id: item.id,
					libraryId: item.libraryId,
					groupId: item.groupId,
					groupSortKey: groupSortKey(item.groupId),
					kind: item.kind,
					title: item.title,
					sortTitle: item.sortTitle,
					playbackPath: item.playbackPath,
					playbackParts: item.parts.length > 0
						? item.parts.flatMap((part) => part.durationSeconds === null
							? []
							: [{ playbackPath: part.playbackPath, durationSeconds: part.durationSeconds }])
						: item.durationMilliseconds === null
							? []
							: [{
								playbackPath: item.playbackPath,
								durationSeconds: item.durationMilliseconds / 1_000,
							}],
					durationSeconds: item.durationMilliseconds === null
						? null
						: item.durationMilliseconds / 1_000,
					seasonNumber: item.seasonNumber,
					episodeNumber: item.episodeNumber,
					episodeEndNumber: item.episodeEndNumber,
					trackNumber: item.trackNumber,
					discNumber: item.discNumber,
					multipartStatus: item.multipartStatus,
					genres: genreMap.get(item.id) ?? [],
					genreNames: genreNameMap.get(item.id) ?? [],
					plot: item.plot,
					year: item.year,
					releaseDate: metadataReleaseDate(metadata),
					dateAddedAt: item.dateAddedAt,
					rating: metadataNumber(metadata, 'rating'),
					userRating: metadataNumber(metadata, 'userRating'),
					actors: metadataPersonNames(metadata, 'actors'),
					directors: metadataStrings(metadata, 'directors'),
					artworkUrl: artworkUrl(
						'items',
						item.id,
						item.artworkRelativePath,
						cacheVersion(metadata, item.fingerprint),
					),
					availability: item.availability,
				};
			}),
			groupParents: Object.fromEntries(groups.map((group) => [group.id, group.parentId])),
			groupKinds: Object.fromEntries(groups.map((group) => [group.id, group.kind])),
			groupTitles: Object.fromEntries(groups.map((group) => [group.id, group.title])),
			libraryNames: Object.fromEntries(
				sourceLibraries.map((library) => [library.id, library.name]),
			),
			libraryAvailability: Object.fromEntries(
				sourceLibraries.map((library) => [
					library.id,
					library.enabled ? library.sourceAvailability : 'unavailable',
				]),
			),
			libraryEnabled: Object.fromEntries(
				sourceLibraries.map((library) => [library.id, library.enabled]),
			),
			mediaAliases,
		});
	}

	/** Load persistent program cursors for one channel. */
	async getSelectionState(channelId: string): Promise<SelectionStateRecord[]> {
		return this.db.$client
			.prepare(
				'SELECT consumer_key AS consumerKey, config_fingerprint AS configFingerprint, value, updated_at AS updatedAt FROM selection_states WHERE channel_id = ? ORDER BY consumer_key',
			)
			.all(channelId)
			.map((row) => {
				const typed = row as Omit<SelectionStateRecord, 'value'> & { value: string };
				return { ...typed, value: JSON.parse(typed.value) } as SelectionStateRecord;
			});
	}

	/** Load persistent program cursors grouped by channel. */
	async getSelectionStatesByChannel(): Promise<Map<string, SelectionStateRecord[]>> {
		const rows = this.db.$client
			.prepare(
				'SELECT channel_id AS channelId, consumer_key AS consumerKey, config_fingerprint AS configFingerprint, value, updated_at AS updatedAt FROM selection_states ORDER BY channel_id, consumer_key',
			)
			.all() as Array<Omit<SelectionStateRecord, 'value'> & { channelId: string; value: string }>;
		const grouped = new Map<string, SelectionStateRecord[]>();
		for (const row of rows) {
			const records = grouped.get(row.channelId) ?? [];
			records.push({
				consumerKey: row.consumerKey,
				configFingerprint: row.configFingerprint,
				value: JSON.parse(row.value) as SelectionStateRecord['value'],
				updatedAt: row.updatedAt,
			});
			grouped.set(row.channelId, records);
		}
		return grouped;
	}

	/** Return the committed timeline window for one channel. */
	async getTimelineMaterialization(
		channelId: string,
	): Promise<TimelineMaterializationRecord | null> {
		const [row] = await this.db
			.select()
			.from(timelineMaterializations)
			.where(and(
				eq(timelineMaterializations.channelId, channelId),
				ne(timelineMaterializations.inputFingerprint, UNCOMMITTED_FAILURE_FINGERPRINT),
			));
		if (!row) {
			return null;
		}

		return {
			channelId: row.channelId,
			health: row.status,
			windowStart: row.windowStart,
			windowEnd: row.windowEnd,
			continuationAt: row.continuationAt,
			inputFingerprint: row.inputFingerprint,
			baseState: row.baseState,
			issues: row.issues,
			guideOccurrences: row.guideOccurrences,
			committedAt: row.committedAt,
			pendingSince: row.pendingSince,
			applyAfter: row.applyAfter,
			lastError: row.lastError,
		};
	}

	/** Return timeline health even when the channel has no successful commit yet. */
	async getTimelineMaterializationStatus(
		channelId: string,
	): Promise<ChannelTimelineMaterializationStatus | null> {
		const [row] = await this.db
			.select()
			.from(timelineMaterializations)
			.where(eq(timelineMaterializations.channelId, channelId));
		return row ? publicMaterializationStatus(row) : null;
	}

	/** List materialization health and pending state for all channels. */
	async listTimelineMaterializationStatuses(): Promise<ChannelTimelineMaterializationStatus[]> {
		return (await this.db.select().from(timelineMaterializations)).map(publicMaterializationStatus);
	}

	/** List committed timeline windows for all channels. */
	async listTimelineMaterializations(): Promise<TimelineMaterializationRecord[]> {
		return (await this.db
			.select()
			.from(timelineMaterializations)
			.where(ne(timelineMaterializations.inputFingerprint, UNCOMMITTED_FAILURE_FINGERPRINT)))
			.map((row) => ({
				channelId: row.channelId,
				health: row.status,
				windowStart: row.windowStart,
				windowEnd: row.windowEnd,
				continuationAt: row.continuationAt,
				inputFingerprint: row.inputFingerprint,
				baseState: row.baseState,
				issues: row.issues,
				guideOccurrences: row.guideOccurrences,
				committedAt: row.committedAt,
				pendingSince: row.pendingSince,
				applyAfter: row.applyAfter,
				lastError: row.lastError,
			}));
	}

	/** Read a committed range in one query; rows retain metadata after catalog deletion. */
	async listMaterializedTimelineSegments(
		rangeStart: string,
		rangeEnd: string,
		channelId?: string,
	): Promise<MaterializedSegmentRecord[]> {
		const range = and(
			gt(materializedTimelineSegments.finishesAt, rangeStart),
			lt(materializedTimelineSegments.startsAt, rangeEnd),
			channelId ? eq(materializedTimelineSegments.channelId, channelId) : undefined,
		);
		const rows = await this.db
			.select()
			.from(materializedTimelineSegments)
			.where(range)
			.orderBy(
				asc(materializedTimelineSegments.channelId),
				asc(materializedTimelineSegments.startsAt),
			);
		return rows.map(materializedSegmentRecord);
	}

	/** Read a chronologically bounded committed range for combined guide responses. */
	async listMaterializedTimelineSegmentsForGuide(
		rangeStart: string,
		rangeEnd: string,
		limit: number,
	): Promise<MaterializedSegmentRecord[]> {
		const rows = await this.db
			.select()
			.from(materializedTimelineSegments)
			.where(and(
				gt(materializedTimelineSegments.finishesAt, rangeStart),
				lt(materializedTimelineSegments.startsAt, rangeEnd),
			))
			.orderBy(
				asc(materializedTimelineSegments.startsAt),
				asc(materializedTimelineSegments.channelId),
			)
			.limit(limit);
		return rows.map(materializedSegmentRecord);
	}

	/** Return one committed segment scoped to its owning channel. */
	async getMaterializedTimelineSegment(
		channelId: string,
		segmentId: string,
	): Promise<MaterializedSegmentRecord | null> {
		const [row] = await this.db
			.select()
			.from(materializedTimelineSegments)
			.where(
				and(
					eq(materializedTimelineSegments.channelId, channelId),
					eq(materializedTimelineSegments.id, segmentId),
				),
			)
			.limit(1);
		return row ? materializedSegmentRecord(row) : null;
	}

	/** Mark already-materialized channels dirty without changing their committed rows. */
	markTimelinePending(channelIds: string[], applyAfter: string, pendingSince: string): void {
		if (channelIds.length === 0) {
			return;
		}

		this.db
			.update(timelineMaterializations)
			.set({
				status: 'pending',
				pendingSince,
				applyAfter,
				lastError: null,
				updatedAt: pendingSince,
			})
			.where(inArray(timelineMaterializations.channelId, channelIds))
			.run();
	}

	/** Record a failed generation while preserving the prior committed timeline. */
	markTimelineFailed(channelId: string, message: string, failedAt: string): void {
		this.db
			.insert(timelineMaterializations)
			.values({
				channelId,
				status: 'failed',
				windowStart: failedAt,
				windowEnd: failedAt,
				continuationAt: failedAt,
				inputFingerprint: UNCOMMITTED_FAILURE_FINGERPRINT,
				baseState: [],
				issues: [],
				committedAt: failedAt,
				pendingSince: null,
				applyAfter: null,
				lastError: message,
				createdAt: failedAt,
				updatedAt: failedAt,
			})
			.onConflictDoUpdate({
				target: timelineMaterializations.channelId,
				set: { status: 'failed', lastError: message, updatedAt: failedAt },
			})
			.run();
	}

	/** Commit generated rows and their exact tail cursor state as one SQLite transaction. */
	commitMaterializedTimeline(input: TimelineCommit): void {
		this.db.transaction((tx) => {
			// Remove the replaceable future and any history before the retained window.
			tx.delete(materializedTimelineSegments)
				.where(
					and(
						eq(materializedTimelineSegments.channelId, input.channelId),
						gt(materializedTimelineSegments.finishesAt, input.replaceFrom),
					),
				)
				.run();
			tx.delete(materializedTimelineSegments)
				.where(
					and(
						eq(materializedTimelineSegments.channelId, input.channelId),
						lte(materializedTimelineSegments.finishesAt, input.windowStart),
					),
				)
				.run();

			// Insert the newly generated concrete segments and their state deltas.
			for (let offset = 0; offset < input.segments.length; offset += TIMELINE_COMMIT_BATCH_SIZE) {
				tx.insert(materializedTimelineSegments)
					.values(
						input.segments.slice(offset, offset + TIMELINE_COMMIT_BATCH_SIZE).map(({ segment, mediaSnapshot, stateDelta, continuation }) => ({
							id: segment.id,
							channelId: segment.channelId,
							scheduleLayerId: segment.scheduleLayerId,
							templateId: segment.templateId,
							slotId: segment.slotId,
							programId: segment.programId,
							mediaItemId: segment.mediaItemId,
							role: segment.role,
							title: segment.title,
							playbackPath: segment.playbackPath,
							playbackParts: segment.playbackParts,
							programAncestry: segment.programAncestry ?? [],
							startsAt: segment.start,
							finishesAt: segment.finish,
							sourceStartSeconds: segment.sourceStartSeconds,
							sourceFinishSeconds: segment.sourceFinishSeconds,
							truncated: segment.truncated,
							mediaSnapshot,
							stateDelta,
							continuation: continuation ?? null,
						})),
					)
					.onConflictDoNothing()
					.run();
			}

			// Replace the channel's persistent content cursors with the generated tail state.
			tx.delete(selectionStates).where(eq(selectionStates.channelId, input.channelId)).run();
			for (let offset = 0; offset < input.finalState.length; offset += TIMELINE_COMMIT_BATCH_SIZE) {
				tx.insert(selectionStates)
					.values(input.finalState.slice(offset, offset + TIMELINE_COMMIT_BATCH_SIZE).map((record) => ({ ...record, channelId: input.channelId })))
					.run();
			}

			// Publish the new window, continuation point, health, and configuration fingerprint.
			tx.insert(timelineMaterializations)
				.values({
					channelId: input.channelId,
					status: 'ready',
					windowStart: input.windowStart,
					windowEnd: input.windowEnd,
					continuationAt: input.continuationAt,
					inputFingerprint: input.inputFingerprint,
					baseState: input.baseState,
					issues: input.issues,
					guideOccurrences: input.guideOccurrences ?? [],
					committedAt: input.committedAt,
					pendingSince: null,
					applyAfter: null,
					lastError: null,
					createdAt: input.committedAt,
					updatedAt: input.committedAt,
				})
				.onConflictDoUpdate({
					target: timelineMaterializations.channelId,
					set: {
						status: 'ready',
						windowStart: input.windowStart,
						windowEnd: input.windowEnd,
						continuationAt: input.continuationAt,
						inputFingerprint: input.inputFingerprint,
						baseState: input.baseState,
						issues: input.issues,
						guideOccurrences: input.guideOccurrences ?? [],
						committedAt: input.committedAt,
						pendingSince: null,
						applyAfter: null,
						lastError: null,
						updatedAt: input.committedAt,
					},
				})
				.run();
		});
	}
}
