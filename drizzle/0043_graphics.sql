CREATE TABLE graphics_presets (
	id TEXT PRIMARY KEY NOT NULL,
	name TEXT NOT NULL,
	name_key TEXT NOT NULL UNIQUE,
	yaml TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE graphics_assets (
	id TEXT PRIMARY KEY NOT NULL,
	name TEXT NOT NULL,
	kind TEXT NOT NULL,
	format TEXT NOT NULL
);
