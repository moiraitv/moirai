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
		const occurrences = sql`FROM materialized_timeline_segments s
			JOIN channels c ON c.id = s.channel_id
			JOIN channel_schedules cs ON cs.channel_id = c.id
			JOIN timeline_materializations t ON t.channel_id = c.id
			WHERE (s.media_item_id = ${id} OR s.media_item_id IN (
				SELECT alias_id FROM media_item_aliases WHERE item_id = ${id}
			)) AND julianday(s.finishes_at) > julianday(${now})
			AND t.window_start < t.window_end AND s.starts_at < t.window_end AND s.finishes_at > t.window_start`;
		const total = tx.get<{ total: number }>(sql`SELECT count(*) AS total ${occurrences}`)!.total;
		const items = tx.all<MediaAirings['items'][number]>(sql`SELECT s.id, c.id AS channelId,
			c.name AS channelName, c.number AS channelNumber, s.starts_at AS startsAt, s.finishes_at AS finishesAt
			${occurrences} ORDER BY s.starts_at, c.number, c.id, s.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
		return { items, total };
	});
}
