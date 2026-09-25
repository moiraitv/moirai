ALTER TABLE media_items ADD COLUMN primary_genre_key text;
--> statement-breakpoint
UPDATE media_items SET primary_genre_key = moirai_primary_genre(metadata);
--> statement-breakpoint
CREATE INDEX media_items_library_primary_genre_idx ON media_items(library_id, primary_genre_key);
