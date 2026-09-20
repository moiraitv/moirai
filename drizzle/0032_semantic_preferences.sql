CREATE TABLE semantic_preferences (
 input_hash TEXT PRIMARY KEY,
 input_text TEXT NOT NULL,
 embedding BLOB,
 status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'failed')),
 generated_at TEXT,
 error_code TEXT
);
