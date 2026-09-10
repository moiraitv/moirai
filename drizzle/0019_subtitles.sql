CREATE TABLE credit_templates (
 id TEXT PRIMARY KEY NOT NULL,
 name TEXT NOT NULL,
 name_key TEXT NOT NULL,
 source TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX credit_templates_name_key_unique ON credit_templates(name_key);
--> statement-breakpoint
ALTER TABLE materialized_timeline_segments ADD COLUMN program_ancestry TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
UPDATE channels SET config = json_set(config, '$.subtitlePreferences', json('{}'), '$.subtitleFontsFolder', NULL)
WHERE json_type(config, '$.subtitlePreferences') IS NULL;
