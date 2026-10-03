import { sql } from 'drizzle-orm';
import type { MediaAirings } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { currentTimestamp } from '../time.js';

/** Read current and upcoming committed occurrences without generating schedules or advancing cursors. */
export function mediaAirings(db: MoiraiDatabase, id: string, page: number, pageSize: number): MediaAirings | null {
	return db.transaction(tx => {
		if (!tx.get(sql`SELECT id FROM media_items WHERE id = ${id}`)) {
			return null;
		}
		const now = currentTimestamp();
		const startsAt = sql`CASE WHEN s.role = 'primary' AND s.airing IS NOT NULL
			THEN json_extract(s.airing, '$.start') ELSE s.starts_at END`;
		const finishesAt = sql`CASE WHEN s.role = 'primary' AND s.airing IS NOT NULL
			THEN json_extract(s.airing, '$.finish') ELSE s.finishes_at END`;
		const occurrences = sql`FROM materialized_timeline_segments s
			JOIN channels c ON c.id = s.channel_id
			JOIN channel_schedules cs ON cs.channel_id = c.id
			JOIN timeline_materializations t ON t.channel_id = c.id
			WHERE (s.media_item_id = ${id} OR s.media_item_id IN (
				SELECT alias_id FROM media_item_aliases WHERE item_id = ${id}
			)) AND (s.airing IS NULL OR s.role <> 'primary' OR s.id = json_extract(s.airing, '$.primarySegmentId'))
			AND julianday(${finishesAt}) > julianday(${now})
			AND t.window_start < t.window_end AND ${startsAt} < t.window_end AND ${finishesAt} > t.window_start`;
		const total = tx.get<{ total: number }>(sql`SELECT count(*) AS total ${occurrences}`)!.total;
		const items = tx.all<MediaAirings['items'][number]>(sql`SELECT s.id, c.id AS channelId,
			c.name AS channelName, c.number AS channelNumber, ${startsAt} AS startsAt, ${finishesAt} AS finishesAt
			${occurrences} ORDER BY ${startsAt}, c.number, c.id, s.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
		return { items, total };
	});
}
