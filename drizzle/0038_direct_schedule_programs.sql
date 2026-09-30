PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__saved_channel_schedule_layers` AS SELECT * FROM `channel_schedule_layers`;
--> statement-breakpoint
DROP TABLE `channel_schedule_layers`;
--> statement-breakpoint
CREATE TABLE `__new_channel_schedules` (
  `channel_id` text PRIMARY KEY NOT NULL REFERENCES `channels`(`id`) ON DELETE cascade,
  `default_template_id` text REFERENCES `schedule_templates`(`id`) ON DELETE restrict,
  `default_program_id` text REFERENCES `scheduling_programs`(`id`) ON DELETE restrict,
  `config` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CHECK ((`default_template_id` IS NULL) <> (`default_program_id` IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_channel_schedules` (`channel_id`,`default_template_id`,`default_program_id`,`config`,`created_at`,`updated_at`)
SELECT `channel_id`,`default_template_id`,NULL,`config`,`created_at`,`updated_at` FROM `channel_schedules`;
--> statement-breakpoint
DROP TABLE `channel_schedules`;
--> statement-breakpoint
ALTER TABLE `__new_channel_schedules` RENAME TO `channel_schedules`;
--> statement-breakpoint
CREATE TABLE `__new_channel_schedule_layers` (
  `id` text PRIMARY KEY NOT NULL,
  `channel_id` text NOT NULL REFERENCES `channel_schedules`(`channel_id`) ON DELETE cascade,
  `position` integer NOT NULL,
  `template_id` text REFERENCES `schedule_templates`(`id`) ON DELETE restrict,
  `program_id` text REFERENCES `scheduling_programs`(`id`) ON DELETE restrict,
  `predicate` text NOT NULL,
  `entry_boundary` text NOT NULL,
  `exit_boundary` text NOT NULL,
  CHECK ((`template_id` IS NULL) <> (`program_id` IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_channel_schedule_layers` (`id`,`channel_id`,`position`,`template_id`,`program_id`,`predicate`,`entry_boundary`,`exit_boundary`)
SELECT `id`,`channel_id`,`position`,`template_id`,NULL,`predicate`,`entry_boundary`,`exit_boundary` FROM `__saved_channel_schedule_layers`;
--> statement-breakpoint
DROP TABLE `__saved_channel_schedule_layers`;
--> statement-breakpoint
ALTER TABLE `__new_channel_schedule_layers` RENAME TO `channel_schedule_layers`;
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_schedule_layers_channel_position` ON `channel_schedule_layers` (`channel_id`,`position`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
