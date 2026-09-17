import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type {
	ViewingPreferenceScores,
	ViewingPreferenceSummary,
} from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { artworkUrl, cacheVersion } from './catalog-records.js';
import {
	mediaGroups,
	mediaItems,
	viewingPreferenceEvents,
} from '../db/schema.js';

const preferenceItemGroup = alias(mediaGroups, 'preference_item_group');
const preferenceItemParent = alias(mediaGroups, 'preference_item_parent');

/** Number of days after which one event retains half its effective value. */
const VIEWING_PREFERENCE_HALF_LIFE_DAYS = 180;
/** Events older than this bounded window are negligible and removed by maintenance. */
export const VIEWING_PREFERENCE_RETENTION_DAYS = 730;

/** Raw aggregate row returned by SQLite's exponential-decay expressions. */
interface PreferenceScoreRow {
	id: string;
	score: number;
}

/** Catalog fields used to label one scored standalone item. */
interface PreferenceItemRow {
	id: string;
	title: string;
	year: number | null;
	kind: string;
	seasonNumber: number | null;
	episodeNumber: number | null;
	episodeEndNumber: number | null;
	edition: string | null;
	artists: string[];
	artworkRelativePath: string | null;
	metadata: Record<string, unknown>;
	fingerprint: string;
	groupId: string | null;
	groupTitle: string | null;
	groupKind: string | null;
	groupArtworkRelativePath: string | null;
	groupMetadata: Record<string, unknown> | null;
	parentId: string | null;
	parentTitle: string | null;
	parentKind: string | null;
	parentArtworkRelativePath: string | null;
	parentMetadata: Record<string, unknown> | null;
}

/** Return a cache-versioned artwork URL when the catalog row has source artwork. */
function preferenceArtwork(
	kind: 'items' | 'groups',
	id: string,
	relativePath: string | null,
	metadata: Record<string, unknown> | null,
	version: string,
): string | null {
	if (!id || !relativePath) {
		return null;
	}

	return artworkUrl(kind, id, relativePath, cacheVersion(metadata ?? {}, version));
}

/** Describe an item with season/episode, artist/album, or release-year labels. */
function preferenceItemSubtitle(item: PreferenceItemRow): string {
	if (item.kind === 'episode' && item.seasonNumber !== null && item.episodeNumber !== null) {
		return 'S' + item.seasonNumber + 'E' + item.episodeNumber
			+ (item.episodeEndNumber != null ? '–E' + item.episodeEndNumber : '');
	}

	if (item.groupKind === 'album') {
		return [item.groupTitle, item.year && item.year > 0 ? String(item.year) : '']
			.filter(Boolean)
			.join(' · ');
	}

	const artists = Array.isArray(item.artists)
		? item.artists.filter((artist) => typeof artist === 'string' && artist.trim())
		: [];
	if (artists.length > 0) {
		return [...artists, item.year && item.year > 0 ? String(item.year) : '']
			.filter(Boolean)
			.join(' · ');
	}

	return [item.year && item.year > 0 ? String(item.year) : '', item.edition]
		.filter(Boolean)
		.join(' · ');
}

/** Prefer item artwork, then the immediate group, then the show or artist parent. */
function preferenceItemArtwork(item: PreferenceItemRow): string | null {
	return preferenceArtwork(
		'items',
		item.id,
		item.artworkRelativePath,
		item.metadata,
		item.fingerprint,
	)
	?? (item.groupId
		? preferenceArtwork(
			'groups',
			item.groupId,
			item.groupArtworkRelativePath,
			item.groupMetadata,
			item.groupId,
		)
		: null)
	?? (item.parentId
		? preferenceArtwork(
			'groups',
			item.parentId,
			item.parentArtworkRelativePath,
			item.parentMetadata,
			item.parentId,
		)
		: null);
}

/** Return the show or artist title that should appear above an item subtitle. */
function preferenceItemParentTitle(item: PreferenceItemRow): string | null {
	if (item.parentKind === 'show' || item.parentKind === 'artist') {
		return item.parentTitle;
	}

	if (item.groupKind === 'show') {
		return item.groupTitle;
	}

	return null;
}

/** Own anonymous viewing events and their bounded, time-decayed aggregate projections. */
export class ViewingPreferenceRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** Persist one qualified encounter and resolve an episode's show ancestor in one statement. */
	recordViewingPreference(
		mediaItemId: string,
		points: 1 | 2,
		encounterType: 'initial' | 'continued',
		occurredAt: string,
	): void {
		this.db.run(sql`
			WITH RECURSIVE ancestors(id, parent_id, kind) AS (
				SELECT groups.id, groups.parent_id, groups.kind
				FROM ${mediaGroups} groups
				JOIN ${mediaItems} items ON items.group_id = groups.id
				WHERE items.id = ${mediaItemId}
				UNION ALL
				SELECT parent.id, parent.parent_id, parent.kind
				FROM ${mediaGroups} parent
				JOIN ancestors child ON child.parent_id = parent.id
			)
			INSERT INTO ${viewingPreferenceEvents}
				(id, media_item_id, show_group_id, points, encounter_type, occurred_at)
			SELECT ${randomUUID()}, items.id,
				(SELECT id FROM ancestors WHERE kind = 'show' LIMIT 1),
				${points}, ${encounterType}, ${occurredAt}
			FROM ${mediaItems} items
			WHERE items.id = ${mediaItemId}
		`);
	}

	/** Return one immutable score snapshot calculated at the requested generation instant. */
	viewingPreferenceScores(asOf: string): ViewingPreferenceScores {
		const cutoff = new Date(
			new Date(asOf).getTime() - VIEWING_PREFERENCE_RETENTION_DAYS * 86_400_000,
		).toISOString();
		const decay = sql<number>`pow(0.5, (julianday(${asOf}) - julianday(${viewingPreferenceEvents.occurredAt})) / ${VIEWING_PREFERENCE_HALF_LIFE_DAYS})`;
		const itemRows = this.db
			.select({ id: viewingPreferenceEvents.mediaItemId, score: sql<number>`sum(${viewingPreferenceEvents.points} * ${decay})` })
			.from(viewingPreferenceEvents)
			.where(and(
				isNotNull(viewingPreferenceEvents.mediaItemId),
				gt(viewingPreferenceEvents.occurredAt, cutoff),
				lt(viewingPreferenceEvents.occurredAt, asOf),
			))
			.groupBy(viewingPreferenceEvents.mediaItemId)
			.all() as PreferenceScoreRow[];
		const showRows = this.db
			.select({ id: viewingPreferenceEvents.showGroupId, score: sql<number>`sum(${viewingPreferenceEvents.points} * ${decay})` })
			.from(viewingPreferenceEvents)
			.where(and(
				isNotNull(viewingPreferenceEvents.showGroupId),
				gt(viewingPreferenceEvents.occurredAt, cutoff),
				lt(viewingPreferenceEvents.occurredAt, asOf),
			))
			.groupBy(viewingPreferenceEvents.showGroupId)
			.all() as PreferenceScoreRow[];

		return {
			itemScores: Object.fromEntries(itemRows.map((row) => [row.id, row.score])),
			showScores: Object.fromEntries(showRows.map((row) => [row.id, row.score])),
		};
	}

	/**
	 * List the strongest current standalone-item and show preferences for administration.
	 * When title is provided, only names containing that substring are ranked into the limit.
	 */
	listViewingPreferences(asOf: string, limit: number, title = ''): ViewingPreferenceSummary[] {
		const scores = this.viewingPreferenceScores(asOf);
		const showIds = Object.keys(scores.showScores);
		const latest = this.db
			.select({
				mediaItemId: viewingPreferenceEvents.mediaItemId,
				showGroupId: viewingPreferenceEvents.showGroupId,
				lastViewedAt: sql<string>`max(${viewingPreferenceEvents.occurredAt})`,
			})
			.from(viewingPreferenceEvents)
			.groupBy(viewingPreferenceEvents.mediaItemId, viewingPreferenceEvents.showGroupId)
			.all();
		const lastItem = new Map<string, string>();
		const lastShow = new Map<string, string>();
		const lastShowPreview = new Map<string, string>();
		for (const row of latest) {
			if (row.mediaItemId && !row.showGroupId) {
				const previous = lastItem.get(row.mediaItemId);
				if (!previous || row.lastViewedAt > previous) {
					lastItem.set(row.mediaItemId, row.lastViewedAt);
				}
			}
			if (row.showGroupId) {
				const previous = lastShow.get(row.showGroupId);
				if (!previous || row.lastViewedAt > previous) {
					lastShow.set(row.showGroupId, row.lastViewedAt);
					if (row.mediaItemId) {
						lastShowPreview.set(row.showGroupId, row.mediaItemId);
					}
				}
			}
		}
		const itemIds = [...lastItem.keys()];
		const items = itemIds.length === 0 ? [] : this.db
			.select({ id: mediaItems.id, title: mediaItems.title })
			.from(mediaItems)
			.where(sql`${mediaItems.id} IN (SELECT value FROM json_each(${JSON.stringify(itemIds)}))`)
			.all();
		const shows = showIds.length === 0 ? [] : this.db
			.select({ id: mediaGroups.id, title: mediaGroups.title })
			.from(mediaGroups)
			.where(sql`${mediaGroups.id} IN (SELECT value FROM json_each(${JSON.stringify(showIds)}))`)
			.all();
		const candidates = [
			...items.map((item) => ({
				id: item.id,
				kind: 'item' as const,
				title: item.title,
				score: scores.itemScores[item.id] ?? 0,
				lastViewedAt: lastItem.get(item.id) ?? asOf,
			})),
			...shows.map((show) => ({
				id: show.id,
				kind: 'show' as const,
				title: show.title,
				score: scores.showScores[show.id] ?? 0,
				lastViewedAt: lastShow.get(show.id) ?? asOf,
			})),
		]
			.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
		const needle = title?.trim().toLocaleLowerCase() ?? '';
		const ranked = (needle
			? candidates.filter((row) => row.title.toLocaleLowerCase().includes(needle))
			: candidates)
			.slice(0, limit);
		const rankedItemIds = ranked.filter((row) => row.kind === 'item').map((row) => row.id);
		const rankedShowIds = ranked.filter((row) => row.kind === 'show').map((row) => row.id);
		const itemDetails = rankedItemIds.length === 0 ? [] : this.db
			.select({
				id: mediaItems.id,
				title: mediaItems.title,
				year: mediaItems.year,
				kind: mediaItems.kind,
				seasonNumber: mediaItems.seasonNumber,
				episodeNumber: mediaItems.episodeNumber,
				episodeEndNumber: mediaItems.episodeEndNumber,
				edition: mediaItems.edition,
				artists: mediaItems.artists,
				artworkRelativePath: mediaItems.artworkRelativePath,
				metadata: mediaItems.metadata,
				fingerprint: mediaItems.fingerprint,
				groupId: preferenceItemGroup.id,
				groupTitle: preferenceItemGroup.title,
				groupKind: preferenceItemGroup.kind,
				groupArtworkRelativePath: preferenceItemGroup.artworkRelativePath,
				groupMetadata: preferenceItemGroup.metadata,
				parentId: preferenceItemParent.id,
				parentTitle: preferenceItemParent.title,
				parentKind: preferenceItemParent.kind,
				parentArtworkRelativePath: preferenceItemParent.artworkRelativePath,
				parentMetadata: preferenceItemParent.metadata,
			})
			.from(mediaItems)
			.leftJoin(preferenceItemGroup, eq(preferenceItemGroup.id, mediaItems.groupId))
			.leftJoin(preferenceItemParent, eq(preferenceItemParent.id, preferenceItemGroup.parentId))
			.where(sql`${mediaItems.id} IN (SELECT value FROM json_each(${JSON.stringify(rankedItemIds)}))`)
			.all();
		const showDetails = rankedShowIds.length === 0 ? [] : this.db
			.select({
				id: mediaGroups.id,
				title: mediaGroups.title,
				year: mediaGroups.year,
				artworkRelativePath: mediaGroups.artworkRelativePath,
				metadata: mediaGroups.metadata,
			})
			.from(mediaGroups)
			.where(sql`${mediaGroups.id} IN (SELECT value FROM json_each(${JSON.stringify(rankedShowIds)}))`)
			.all();
		const itemsById = new Map(itemDetails.map((item) => [item.id, item]));
		const showsById = new Map(showDetails.map((show) => [show.id, show]));
		return ranked.map((row) => {
			if (row.kind === 'item') {
				const item = itemsById.get(row.id);
				return {
					...row,
					artworkUrl: item ? preferenceItemArtwork(item) : null,
					year: item?.year ?? null,
					subtitle: item ? preferenceItemSubtitle(item) : '',
					parentTitle: item ? preferenceItemParentTitle(item) : null,
					previewItemId: row.id,
				};
			}

			const show = showsById.get(row.id);
			return {
				...row,
				artworkUrl: show
					? preferenceArtwork(
						'groups',
						show.id,
						show.artworkRelativePath,
						show.metadata,
						show.id,
					)
					: null,
				year: show?.year ?? null,
				subtitle: show?.year && show.year > 0 ? String(show.year) : '',
				parentTitle: null,
				previewItemId: lastShowPreview.get(row.id) ?? row.id,
			};
		});
	}

	/** Delete every learned preference event. */
	clearViewingPreferences(): void {
		this.db.delete(viewingPreferenceEvents).run();
	}

	/** Delete expired or fully orphaned events during bounded maintenance. */
	pruneViewingPreferences(cutoff: string): void {
		this.db.delete(viewingPreferenceEvents)
			.where(or(
				lt(viewingPreferenceEvents.occurredAt, cutoff),
				and(
					isNull(viewingPreferenceEvents.mediaItemId),
					isNull(viewingPreferenceEvents.showGroupId),
				),
			))
			.run();
	}
}
