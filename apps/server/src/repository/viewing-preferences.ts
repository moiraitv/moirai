import { randomUUID } from 'node:crypto';
import { and, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type {
	ViewingPreferenceScores,
	ViewingPreferenceSummary,
} from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import {
	mediaGroups,
	mediaItems,
	viewingPreferenceEvents,
} from '../db/schema.js';

/** Number of days after which one event retains half its effective value. */
const VIEWING_PREFERENCE_HALF_LIFE_DAYS = 180;
/** Events older than this bounded window are negligible and removed by maintenance. */
export const VIEWING_PREFERENCE_RETENTION_DAYS = 730;

/** Raw aggregate row returned by SQLite's exponential-decay expressions. */
interface PreferenceScoreRow {
	id: string;
	score: number;
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

	/** List the strongest current standalone-item and show preferences for administration. */
	listViewingPreferences(asOf: string, limit: number): ViewingPreferenceSummary[] {
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
		const summaries: ViewingPreferenceSummary[] = [
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
		];
		return summaries
			.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
			.slice(0, limit);
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
