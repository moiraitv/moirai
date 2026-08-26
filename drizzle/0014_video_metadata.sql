ALTER TABLE `media_items` ADD `episode_end_number` integer;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `edition` text;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `external_ids` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `media_items` ADD `track_number` integer;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `disc_number` integer;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `artists` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `media_items` ADD `multipart_status` text NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE `media_items` ADD `parts` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `media_items` ADD `subtitle_tracks` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `materialized_timeline_segments` ADD `playback_parts` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
CREATE TABLE `media_item_aliases` (
	`alias_id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`item_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_item_aliases_item_idx` ON `media_item_aliases` (`item_id`);
