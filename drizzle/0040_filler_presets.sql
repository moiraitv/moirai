ALTER TABLE mid_roll_presets RENAME TO filler_presets;
--> statement-breakpoint
ALTER TABLE filler_presets ADD COLUMN kind text NOT NULL DEFAULT 'mid-roll';
--> statement-breakpoint
DROP INDEX mid_roll_presets_name_key_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX filler_presets_kind_name_key_unique ON filler_presets(kind, name_key);
--> statement-breakpoint
UPDATE filler_presets SET config = json_set(config, '$.kind', 'mid-roll');
--> statement-breakpoint
ALTER TABLE schedule_templates ADD COLUMN default_pre_roll text;
--> statement-breakpoint
ALTER TABLE schedule_templates ADD COLUMN default_post_roll text;
--> statement-breakpoint
ALTER TABLE schedule_slots ADD COLUMN pre_roll text NOT NULL DEFAULT '{"mode":"inherit"}';
--> statement-breakpoint
ALTER TABLE schedule_slots ADD COLUMN post_roll text NOT NULL DEFAULT '{"mode":"inherit"}';
--> statement-breakpoint
INSERT INTO filler_presets (id, kind, name, name_key, config, is_builtin) VALUES ('a40c0000-0000-4000-8000-000000000001', 'pre-roll', 'One-item introduction', 'one-item introduction', '{"id":"a40c0000-0000-4000-8000-000000000001","kind":"pre-roll","name":"One-item introduction","description":"One complete filler item before each primary item.","budget":{"type":"count","count":1}}', 1);
--> statement-breakpoint
INSERT INTO filler_presets (id, kind, name, name_key, config, is_builtin) VALUES ('a40c0000-0000-4000-8000-000000000002', 'post-roll', 'One-item closing', 'one-item closing', '{"id":"a40c0000-0000-4000-8000-000000000002","kind":"post-roll","name":"One-item closing","description":"One complete filler item after each primary item.","budget":{"type":"count","count":1}}', 1);
--> statement-breakpoint
INSERT INTO filler_presets (id, kind, name, name_key, config, is_builtin) VALUES ('a40c0000-0000-4000-8000-000000000003', 'tail', 'Remaining slot: best-fit-or-truncate', 'remaining slot: best-fit-or-truncate', '{"id":"a40c0000-0000-4000-8000-000000000003","kind":"tail","name":"Remaining slot: best-fit-or-truncate","description":"Fill the remaining slot using the selected fitting policy.","budget":{"type":"remaining","policy":"best-fit-or-truncate"}}', 1);
--> statement-breakpoint
INSERT INTO filler_presets (id, kind, name, name_key, config, is_builtin) VALUES ('a40c0000-0000-4000-8000-000000000004', 'tail', 'Remaining slot: best-fit-only', 'remaining slot: best-fit-only', '{"id":"a40c0000-0000-4000-8000-000000000004","kind":"tail","name":"Remaining slot: best-fit-only","description":"Fill the remaining slot using the selected fitting policy.","budget":{"type":"remaining","policy":"best-fit-only"}}', 1);
--> statement-breakpoint
INSERT INTO filler_presets (id, kind, name, name_key, config, is_builtin) VALUES ('a40c0000-0000-4000-8000-000000000005', 'tail', 'Remaining slot: next-truncate', 'remaining slot: next-truncate', '{"id":"a40c0000-0000-4000-8000-000000000005","kind":"tail","name":"Remaining slot: next-truncate","description":"Fill the remaining slot using the selected fitting policy.","budget":{"type":"remaining","policy":"next-truncate"}}', 1);
--> statement-breakpoint
INSERT INTO filler_presets (id, kind, name, name_key, config, is_builtin) VALUES ('a40c0000-0000-4000-8000-000000000006', 'tail', 'Remaining slot: next-fit-only', 'remaining slot: next-fit-only', '{"id":"a40c0000-0000-4000-8000-000000000006","kind":"tail","name":"Remaining slot: next-fit-only","description":"Fill the remaining slot using the selected fitting policy.","budget":{"type":"remaining","policy":"next-fit-only"}}', 1);
--> statement-breakpoint
UPDATE schedule_templates SET default_filler = json_set(default_filler, '$.presetId', CASE coalesce(json_extract(default_filler, '$.policy'), 'best-fit-or-truncate') WHEN 'best-fit-or-truncate' THEN 'a40c0000-0000-4000-8000-000000000003' WHEN 'best-fit-only' THEN 'a40c0000-0000-4000-8000-000000000004' WHEN 'next-truncate' THEN 'a40c0000-0000-4000-8000-000000000005' WHEN 'next-fit-only' THEN 'a40c0000-0000-4000-8000-000000000006' END) WHERE default_filler IS NOT NULL;
--> statement-breakpoint
UPDATE schedule_slots SET filler = json_set(filler, '$.config.presetId', CASE coalesce(json_extract(json_extract(filler, '$.config'), '$.policy'), 'best-fit-or-truncate') WHEN 'best-fit-or-truncate' THEN 'a40c0000-0000-4000-8000-000000000003' WHEN 'best-fit-only' THEN 'a40c0000-0000-4000-8000-000000000004' WHEN 'next-truncate' THEN 'a40c0000-0000-4000-8000-000000000005' WHEN 'next-fit-only' THEN 'a40c0000-0000-4000-8000-000000000006' END) WHERE json_extract(filler, '$.mode') = 'configured';
--> statement-breakpoint
UPDATE channel_schedules SET config = json_set(config, '$.defaultFiller', NULL, '$.defaultTailFiller', json_set(json_extract(config, '$.defaultFiller'), '$.legacyEmptySlots', json('true'), '$.presetId', CASE coalesce(json_extract(json_extract(config, '$.defaultFiller'), '$.policy'), 'best-fit-or-truncate') WHEN 'best-fit-or-truncate' THEN 'a40c0000-0000-4000-8000-000000000003' WHEN 'best-fit-only' THEN 'a40c0000-0000-4000-8000-000000000004' WHEN 'next-truncate' THEN 'a40c0000-0000-4000-8000-000000000005' WHEN 'next-fit-only' THEN 'a40c0000-0000-4000-8000-000000000006' END)) WHERE json_type(config, '$.defaultFiller') = 'object';
