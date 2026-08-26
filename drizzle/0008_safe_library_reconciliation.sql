ALTER TABLE `libraries` ADD `accepted_source_identity` text;
--> statement-breakpoint
ALTER TABLE `libraries` ADD `pending_source_definition` text;
--> statement-breakpoint
ALTER TABLE `libraries` ADD `candidate_source_identity` text;
--> statement-breakpoint
ALTER TABLE `libraries` ADD `candidate_manifest` text;
--> statement-breakpoint
ALTER TABLE `libraries` ADD `candidate_summary` text;
--> statement-breakpoint
ALTER TABLE `libraries` ADD `reconciliation_status` text DEFAULT 'idle' NOT NULL;
--> statement-breakpoint
ALTER TABLE `libraries` ADD `reconciliation_revision` text;
--> statement-breakpoint
ALTER TABLE `libraries` ADD `pending_removal_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `media_removal_tombstones` (
  `item_id` text PRIMARY KEY NOT NULL REFERENCES `media_items`(`id`) ON DELETE cascade,
  `library_id` text NOT NULL REFERENCES `libraries`(`id`) ON DELETE cascade,
  `source_identity_hash` text NOT NULL,
  `first_missing_at` text NOT NULL,
  `last_missing_at` text NOT NULL,
  `last_counted_at` text,
  `consecutive_observations` integer DEFAULT 0 NOT NULL,
  `last_scan_id` text REFERENCES `scan_runs`(`id`) ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `media_removal_tombstones_library_idx` ON `media_removal_tombstones` (`library_id`,`item_id`);
