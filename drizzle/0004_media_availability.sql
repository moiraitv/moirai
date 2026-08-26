ALTER TABLE `libraries` ADD `source_availability` text DEFAULT 'available' NOT NULL;
--> statement-breakpoint
ALTER TABLE `libraries` ADD `source_availability_updated_at` text;
--> statement-breakpoint
UPDATE `libraries`
SET `source_availability_updated_at` = COALESCE(`last_scan_completed_at`, `updated_at`);
--> statement-breakpoint
ALTER TABLE `media_items` ADD `availability` text DEFAULT 'available' NOT NULL;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `last_observed_at` text;
--> statement-breakpoint
UPDATE `media_items`
SET `last_observed_at` = `updated_at`;
