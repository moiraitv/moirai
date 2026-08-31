CREATE TABLE `libraries` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `type_key` text NOT NULL,
  `source_type` text NOT NULL,
  `source_config` text NOT NULL,
  `scan_interval_minutes` integer DEFAULT 180 NOT NULL,
  `watcher_enabled` integer DEFAULT 1 NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `watcher_status` text DEFAULT 'stopped' NOT NULL,
  `last_scan_started_at` text,
  `last_scan_completed_at` text,
  `last_change_detected_at` text,
  `last_indexed_change_at` text,
  `warning_count` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_groups` (
  `id` text PRIMARY KEY NOT NULL,
  `library_id` text NOT NULL REFERENCES `libraries`(`id`) ON DELETE cascade,
  `parent_id` text,
  `stable_key` text NOT NULL,
  `kind` text NOT NULL,
  `title` text NOT NULL,
  `sort_title` text NOT NULL,
  `year` integer,
  `plot` text,
  `metadata` text NOT NULL,
  `artwork_relative_path` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_groups_library_stable_key` ON `media_groups` (`library_id`,`stable_key`);
--> statement-breakpoint
CREATE INDEX `media_groups_parent_idx` ON `media_groups` (`library_id`,`parent_id`);
--> statement-breakpoint
CREATE TABLE `media_items` (
  `id` text PRIMARY KEY NOT NULL,
  `library_id` text NOT NULL REFERENCES `libraries`(`id`) ON DELETE cascade,
  `group_id` text REFERENCES `media_groups`(`id`) ON DELETE set null,
  `stable_key` text NOT NULL,
  `kind` text NOT NULL,
  `title` text NOT NULL,
  `sort_title` text NOT NULL,
  `relative_path` text NOT NULL,
  `playback_path` text NOT NULL,
  `nfo_relative_path` text,
  `plot` text,
  `year` integer,
  `duration_seconds` integer,
  `season_number` integer,
  `episode_number` integer,
  `metadata_status` text NOT NULL,
  `metadata` text NOT NULL,
  `artwork_relative_path` text,
  `fingerprint` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_items_library_relative_path` ON `media_items` (`library_id`,`relative_path`);
--> statement-breakpoint
CREATE INDEX `media_items_library_group_idx` ON `media_items` (`library_id`,`group_id`);
--> statement-breakpoint
CREATE INDEX `media_items_library_title_idx` ON `media_items` (`library_id`,`sort_title`);
--> statement-breakpoint
CREATE TABLE `viewing_preference_events` (
  `id` text PRIMARY KEY NOT NULL,
  `media_item_id` text REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE set null,
  `show_group_id` text REFERENCES `media_groups`(`id`) ON UPDATE no action ON DELETE set null,
  `points` integer NOT NULL,
  `encounter_type` text NOT NULL,
  `occurred_at` text NOT NULL,
  CONSTRAINT `viewing_preference_events_points` CHECK(`points` IN (1, 2))
);
--> statement-breakpoint
CREATE INDEX `viewing_preference_events_time_idx` ON `viewing_preference_events` (`occurred_at`);
--> statement-breakpoint
CREATE INDEX `viewing_preference_events_item_idx` ON `viewing_preference_events` (`media_item_id`);
--> statement-breakpoint
CREATE INDEX `viewing_preference_events_show_idx` ON `viewing_preference_events` (`show_group_id`);
--> statement-breakpoint
CREATE TABLE `scan_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `library_id` text NOT NULL REFERENCES `libraries`(`id`) ON DELETE cascade,
  `scan_trigger` text NOT NULL,
  `status` text NOT NULL,
  `started_at` text NOT NULL,
  `completed_at` text,
  `discovered_count` integer DEFAULT 0 NOT NULL,
  `changed_count` integer DEFAULT 0 NOT NULL,
  `removed_count` integer DEFAULT 0 NOT NULL,
  `issues` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scan_runs_library_started_idx` ON `scan_runs` (`library_id`,`started_at`);
--> statement-breakpoint
CREATE TABLE `channels` (
  `id` text PRIMARY KEY NOT NULL,
  `number` text NOT NULL UNIQUE,
  `name` text NOT NULL,
  `config` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
