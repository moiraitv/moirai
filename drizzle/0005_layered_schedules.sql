PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_schedule_slots` (
  `id` text PRIMARY KEY NOT NULL,
  `template_id` text NOT NULL REFERENCES `schedule_templates`(`id`) ON DELETE cascade,
  `position` integer NOT NULL,
  `start_seconds` integer NOT NULL,
  `program_id` text REFERENCES `scheduling_programs`(`id`) ON DELETE restrict,
  `state_scope` text NOT NULL,
  `start_eligibility` text NOT NULL,
  `filler` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_schedule_slots` SELECT `id`,`template_id`,`position`,`start_seconds`,`program_id`,`state_scope`,`start_eligibility`,`filler` FROM `schedule_slots`;
--> statement-breakpoint
CREATE TABLE `__old_schedule_boundaries` AS SELECT * FROM `schedule_boundaries`;
--> statement-breakpoint
DROP TABLE `schedule_boundaries`;
--> statement-breakpoint
DROP TABLE `schedule_slots`;
--> statement-breakpoint
ALTER TABLE `__new_schedule_slots` RENAME TO `schedule_slots`;
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
INSERT INTO `schedule_boundaries` SELECT `id`,`template_id`,`position`,`left_slot_id`,`right_slot_id`,`target_seconds`,`policy`,`max_drift_seconds`,`fallback` FROM `__old_schedule_boundaries`;
--> statement-breakpoint
DROP TABLE `__old_schedule_boundaries`;
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_boundaries_template_position` ON `schedule_boundaries` (`template_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_boundaries_template_target` ON `schedule_boundaries` (`template_id`,`target_seconds`);
--> statement-breakpoint
CREATE TABLE `channel_schedule_layers` (
  `id` text PRIMARY KEY NOT NULL,
  `channel_id` text NOT NULL REFERENCES `channel_schedules`(`channel_id`) ON DELETE cascade,
  `position` integer NOT NULL,
  `template_id` text NOT NULL REFERENCES `schedule_templates`(`id`) ON DELETE restrict,
  `predicate` text NOT NULL,
  `entry_boundary` text NOT NULL,
  `exit_boundary` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_schedule_layers_channel_position` ON `channel_schedule_layers` (`channel_id`,`position`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
