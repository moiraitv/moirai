CREATE TABLE encoding_profiles (
 id TEXT PRIMARY KEY NOT NULL,
 name TEXT NOT NULL,
 name_key TEXT NOT NULL,
 config TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX encoding_profiles_name_key_unique ON encoding_profiles(name_key);
--> statement-breakpoint
UPDATE channels SET config = json_set(config, '$.encodingProfileId', NULL)
WHERE json_type(config, '$.encodingProfileId') IS NULL;
