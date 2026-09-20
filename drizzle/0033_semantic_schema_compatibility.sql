-- Earlier development installs applied 0031/0032 before these columns were added.
-- Rebuild from their common columns so either prior schema upgrades safely.
-- Startup resets optimistic revision counters and transient preparation errors only.
CREATE TABLE semantic_preferences_upgrade (
 input_hash TEXT PRIMARY KEY,
 input_text TEXT NOT NULL,
 embedding BLOB,
 status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'failed')),
 generated_at TEXT,
 error_code TEXT
);
--> statement-breakpoint
INSERT INTO semantic_preferences_upgrade(input_hash,input_text,embedding,status,generated_at)
SELECT input_hash,input_text,embedding,status,generated_at FROM semantic_preferences;
--> statement-breakpoint
DROP TABLE semantic_preferences;
--> statement-breakpoint
ALTER TABLE semantic_preferences_upgrade RENAME TO semantic_preferences;
--> statement-breakpoint
CREATE TABLE timeline_materializations_upgrade (
 channel_id TEXT PRIMARY KEY NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 status TEXT NOT NULL,
 window_start TEXT NOT NULL,
 window_end TEXT NOT NULL,
 continuation_at TEXT NOT NULL,
 input_fingerprint TEXT NOT NULL,
 base_state TEXT NOT NULL,
 issues TEXT NOT NULL,
 committed_at TEXT NOT NULL,
 pending_since TEXT,
 apply_after TEXT,
 last_error TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
 guide_occurrences TEXT NOT NULL DEFAULT '[]',
 revision INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO timeline_materializations_upgrade
 (channel_id,status,window_start,window_end,continuation_at,input_fingerprint,base_state,
 issues,committed_at,pending_since,apply_after,last_error,created_at,updated_at,guide_occurrences)
SELECT channel_id,status,window_start,window_end,continuation_at,input_fingerprint,base_state,
 issues,committed_at,pending_since,apply_after,last_error,created_at,updated_at,guide_occurrences
FROM timeline_materializations;
--> statement-breakpoint
DROP TABLE timeline_materializations;
--> statement-breakpoint
ALTER TABLE timeline_materializations_upgrade RENAME TO timeline_materializations;
