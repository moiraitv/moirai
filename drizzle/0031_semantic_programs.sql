CREATE TABLE media_embeddings (
 media_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
 model_id TEXT NOT NULL,
 model_revision TEXT NOT NULL,
 input_version INTEGER NOT NULL,
 input_hash TEXT NOT NULL,
 dimensions INTEGER NOT NULL,
 embedding BLOB,
 generated_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'failed')),
 error_code TEXT
);
--> statement-breakpoint
CREATE TABLE similarity_seeds (
 consumer_key TEXT NOT NULL,
 generation INTEGER NOT NULL,
 program_id TEXT NOT NULL REFERENCES scheduling_programs(id) ON DELETE CASCADE,
 channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 source_item_ids TEXT NOT NULL,
 config TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(consumer_key, generation)
);
--> statement-breakpoint
CREATE TABLE similarity_seed_items (
 consumer_key TEXT NOT NULL,
 generation INTEGER NOT NULL,
 media_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 PRIMARY KEY(consumer_key, generation, ordinal),
 UNIQUE(consumer_key, generation, media_id),
 FOREIGN KEY(consumer_key, generation) REFERENCES similarity_seeds(consumer_key, generation) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX similarity_seeds_channel_idx ON similarity_seeds(channel_id);
--> statement-breakpoint
ALTER TABLE timeline_materializations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
