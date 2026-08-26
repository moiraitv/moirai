CREATE TABLE `scheduling_programs` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `config` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedule_templates` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `period` text DEFAULT 'day' NOT NULL,
  `default_filler` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedule_slots` (
  `id` text PRIMARY KEY NOT NULL,
  `template_id` text NOT NULL REFERENCES `schedule_templates`(`id`) ON DELETE cascade,
  `position` integer NOT NULL,
  `start_seconds` integer NOT NULL,
  `program_id` text NOT NULL REFERENCES `scheduling_programs`(`id`) ON DELETE restrict,
  `state_scope` text NOT NULL,
  `start_eligibility` text NOT NULL,
  `filler` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_slots_template_position` ON `schedule_slots` (`template_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_slots_template_start` ON `schedule_slots` (`template_id`,`start_seconds`);
--> statement-breakpoint
CREATE TABLE `schedule_boundaries` (
  `id` text PRIMARY KEY NOT NULL,
  `template_id` text NOT NULL REFERENCES `schedule_templates`(`id`) ON DELETE cascade,
  `position` integer NOT NULL,
  `left_slot_id` text NOT NULL REFERENCES `schedule_slots`(`id`) ON DELETE cascade,
  `right_slot_id` text NOT NULL REFERENCES `schedule_slots`(`id`) ON DELETE cascade,
  `target_seconds` integer NOT NULL,
  `policy` text NOT NULL,
  `max_drift_seconds` integer NOT NULL,
  `fallback` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_boundaries_template_position` ON `schedule_boundaries` (`template_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_boundaries_template_target` ON `schedule_boundaries` (`template_id`,`target_seconds`);
--> statement-breakpoint
CREATE TABLE `channel_schedules` (
  `channel_id` text PRIMARY KEY NOT NULL REFERENCES `channels`(`id`) ON DELETE cascade,
  `default_template_id` text NOT NULL REFERENCES `schedule_templates`(`id`) ON DELETE restrict,
  `config` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `selection_states` (
  `consumer_key` text PRIMARY KEY NOT NULL,
  `channel_id` text NOT NULL REFERENCES `channels`(`id`) ON DELETE cascade,
  `config_fingerprint` text NOT NULL,
  `value` text NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `selection_states_channel_idx` ON `selection_states` (`channel_id`);
