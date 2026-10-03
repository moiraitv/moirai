UPDATE channel_schedules
SET config = json_set(config, '$.defaultFiller', NULL, '$.defaultTailFiller.legacyEmptySlots', json('true'))
WHERE json_type(config, '$.defaultFiller') = 'object'
AND json_type(config, '$.defaultTailFiller') = 'object'
AND json_extract(config, '$.defaultFiller.programId') = json_extract(config, '$.defaultTailFiller.programId')
AND coalesce(json_extract(config, '$.defaultFiller.policy'), 'best-fit-or-truncate') = json_extract(config, '$.defaultTailFiller.policy')
AND json_extract(config, '$.defaultTailFiller.presetId') = CASE coalesce(json_extract(config, '$.defaultFiller.policy'), 'best-fit-or-truncate')
WHEN 'best-fit-or-truncate' THEN 'a40c0000-0000-4000-8000-000000000003'
WHEN 'best-fit-only' THEN 'a40c0000-0000-4000-8000-000000000004'
WHEN 'next-truncate' THEN 'a40c0000-0000-4000-8000-000000000005'
WHEN 'next-fit-only' THEN 'a40c0000-0000-4000-8000-000000000006' END
AND json_type(config, '$.defaultTailFiller.legacyEmptySlots') IS NULL;
--> statement-breakpoint
CREATE INDEX materialized_segments_start_idx ON materialized_timeline_segments(starts_at, channel_id);
--> statement-breakpoint
CREATE INDEX materialized_segments_airing_id_idx ON materialized_timeline_segments(json_extract(airing, '$.id'));
--> statement-breakpoint
CREATE INDEX materialized_segments_channel_airing_id_idx ON materialized_timeline_segments(channel_id, json_extract(airing, '$.id'));
--> statement-breakpoint
CREATE INDEX materialized_segments_channel_airing_finish_idx ON materialized_timeline_segments(channel_id, coalesce(json_extract(airing, '$.finish'), finishes_at));
