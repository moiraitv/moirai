ALTER TABLE schedule_templates ADD COLUMN default_mid_roll text;
--> statement-breakpoint
ALTER TABLE schedule_slots ADD COLUMN mid_roll text NOT NULL DEFAULT '{"mode":"inherit"}';
--> statement-breakpoint
ALTER TABLE materialized_timeline_segments ADD COLUMN airing text;

--> statement-breakpoint
CREATE TABLE mid_roll_presets (
 id text PRIMARY KEY NOT NULL, name text NOT NULL, name_key text NOT NULL, config text NOT NULL,
 is_builtin integer NOT NULL DEFAULT 0, created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX mid_roll_presets_name_key_unique ON mid_roll_presets(name_key);
--> statement-breakpoint
INSERT INTO mid_roll_presets (id, name, name_key, config, is_builtin) VALUES ('a39c0000-0000-4000-8000-000000000001', 'Two-minute breaks', 'two-minute breaks', '{"name":"Two-minute breaks","description":"Two minutes of filler with ten minutes of content between breaks.","fallbackIntervalSeconds":600,"predicate":{"type":"all","children":[{"type":"number","field":"point","operator":"gte","value":600,"negated":false},{"type":"number","field":"last_mid_filler","operator":"gte","value":600,"negated":false},{"type":"number","field":"remaining_duration","operator":"gte","value":120,"negated":false}]},"budget":{"type":"duration","seconds":120,"policy":"best-fit-or-truncate"}}', 1);
--> statement-breakpoint
INSERT INTO mid_roll_presets (id, name, name_key, config, is_builtin) VALUES ('a39c0000-0000-4000-8000-000000000002', 'One-item breaks', 'one-item breaks', '{"name":"One-item breaks","description":"One full filler item with ten minutes of content between breaks.","fallbackIntervalSeconds":600,"predicate":{"type":"all","children":[{"type":"number","field":"point","operator":"gte","value":600,"negated":false},{"type":"number","field":"last_mid_filler","operator":"gte","value":600,"negated":false},{"type":"number","field":"remaining_duration","operator":"gte","value":120,"negated":false}]},"budget":{"type":"count","count":1}}', 1);
