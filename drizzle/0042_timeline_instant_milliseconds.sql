DROP INDEX IF EXISTS materialized_segments_channel_start_idx;
--> statement-breakpoint
CREATE INDEX materialized_segments_channel_start_idx
ON materialized_timeline_segments(channel_id, (CAST(strftime('%s', starts_at) AS INTEGER) * 1000 + CAST(substr(strftime('%f', starts_at), 4, 3) AS INTEGER)));
--> statement-breakpoint
DROP INDEX IF EXISTS materialized_segments_channel_finish_idx;
--> statement-breakpoint
CREATE INDEX materialized_segments_channel_finish_idx
ON materialized_timeline_segments(channel_id, (CAST(strftime('%s', finishes_at) AS INTEGER) * 1000 + CAST(substr(strftime('%f', finishes_at), 4, 3) AS INTEGER)));
--> statement-breakpoint
DROP INDEX IF EXISTS materialized_segments_start_idx;
--> statement-breakpoint
CREATE INDEX materialized_segments_start_idx
ON materialized_timeline_segments((CAST(strftime('%s', starts_at) AS INTEGER) * 1000 + CAST(substr(strftime('%f', starts_at), 4, 3) AS INTEGER)), channel_id);
--> statement-breakpoint
DROP INDEX IF EXISTS materialized_segments_channel_airing_finish_idx;
--> statement-breakpoint
CREATE INDEX materialized_segments_channel_airing_finish_idx
ON materialized_timeline_segments(channel_id, (CAST(strftime('%s', coalesce(json_extract(airing, '$.finish'), finishes_at)) AS INTEGER) * 1000 + CAST(substr(strftime('%f', coalesce(json_extract(airing, '$.finish'), finishes_at)), 4, 3) AS INTEGER)));
--> statement-breakpoint
-- Repair only elapsed subsecond prefixes left by the former timestamp text comparisons.
-- No retained media, cursor state, schedule configuration, or pending changes are replaced.
CREATE TEMP TABLE moirai_timeline_prefix_repairs AS
WITH retained AS (
	SELECT t.channel_id, t.window_start, s.starts_at AS gap_finish,
		s.schedule_layer_id, s.template_id, s.slot_id,
		(CAST(strftime('%s', t.window_start) AS INTEGER) * 1000 + CAST(substr(strftime('%f', t.window_start), 4, 3) AS INTEGER)) AS window_start_ms,
		(CAST(strftime('%s', t.window_end) AS INTEGER) * 1000 + CAST(substr(strftime('%f', t.window_end), 4, 3) AS INTEGER)) AS window_end_ms,
		(CAST(strftime('%s', s.starts_at) AS INTEGER) * 1000 + CAST(substr(strftime('%f', s.starts_at), 4, 3) AS INTEGER)) AS first_start_ms
	FROM timeline_materializations t
	JOIN materialized_timeline_segments s ON s.id = (
		SELECT id FROM materialized_timeline_segments
		WHERE channel_id = t.channel_id
		ORDER BY (CAST(strftime('%s', starts_at) AS INTEGER) * 1000 + CAST(substr(strftime('%f', starts_at), 4, 3) AS INTEGER)) LIMIT 1
	)
	WHERE t.status IN ('ready', 'pending', 'failed')
)
SELECT channel_id, window_start, gap_finish, schedule_layer_id, template_id, slot_id
FROM retained
WHERE window_start_ms < window_end_ms
AND first_start_ms > window_start_ms AND first_start_ms - window_start_ms < 1000
AND CAST(strftime('%s', gap_finish) AS INTEGER) = CAST(strftime('%s', window_start) AS INTEGER)
AND first_start_ms < window_end_ms
AND first_start_ms <= (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER));
--> statement-breakpoint
INSERT INTO materialized_timeline_segments (
	id, channel_id, schedule_layer_id, template_id, slot_id, role, title,
	starts_at, finishes_at, source_start_seconds, source_finish_seconds, truncated, state_delta
)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
	|| substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2)
	|| '-' || lower(hex(randomblob(6))),
	channel_id, schedule_layer_id, template_id, slot_id, 'dead-air', 'Dead air',
	window_start, gap_finish, 0, NULL, 0, '[]'
FROM moirai_timeline_prefix_repairs;
--> statement-breakpoint
-- Preserve configuration commit time so pending authored edits keep their application boundary.
UPDATE timeline_materializations
SET revision = revision + 1,
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE channel_id IN (SELECT channel_id FROM moirai_timeline_prefix_repairs);
--> statement-breakpoint
DROP TABLE moirai_timeline_prefix_repairs;
