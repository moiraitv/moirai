ALTER TABLE `media_items` ADD `duration_milliseconds` integer;--> statement-breakpoint
ALTER TABLE `media_items` ADD `probe_fingerprint` text;--> statement-breakpoint
ALTER TABLE `media_items` ADD `probe_status` text NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `media_items` ADD `probe_updated_at` text;--> statement-breakpoint
ALTER TABLE `media_items` ADD `probe_error_code` text;--> statement-breakpoint
ALTER TABLE `media_items` ADD `technical_metadata` text NOT NULL DEFAULT '{}';--> statement-breakpoint
UPDATE `media_items` SET `duration_seconds` = NULL;--> statement-breakpoint
DELETE FROM `materialized_timeline_segments`;--> statement-breakpoint
DELETE FROM `timeline_materializations`;
