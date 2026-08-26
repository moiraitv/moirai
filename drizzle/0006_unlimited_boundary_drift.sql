PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_schedule_boundaries` (
  `id` text PRIMARY KEY NOT NULL,
  `template_id` text NOT NULL REFERENCES `schedule_templates`(`id`) ON DELETE cascade,
  `position` integer NOT NULL,
  `left_slot_id` text NOT NULL REFERENCES `schedule_slots`(`id`) ON DELETE cascade,
  `right_slot_id` text NOT NULL REFERENCES `schedule_slots`(`id`) ON DELETE cascade,
  `target_seconds` integer NOT NULL,
  `policy` text NOT NULL,
  `max_drift_seconds` integer,
  `fallback` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_schedule_boundaries` SELECT `id`,`template_id`,`position`,`left_slot_id`,`right_slot_id`,`target_seconds`,`policy`,`max_drift_seconds`,`fallback` FROM `schedule_boundaries`;
--> statement-breakpoint
DROP TABLE `schedule_boundaries`;
--> statement-breakpoint
ALTER TABLE `__new_schedule_boundaries` RENAME TO `schedule_boundaries`;
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_boundaries_template_position` ON `schedule_boundaries` (`template_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_boundaries_template_target` ON `schedule_boundaries` (`template_id`,`target_seconds`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
