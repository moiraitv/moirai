ALTER TABLE `libraries` ADD `name_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_name_key_unique` ON `libraries` (`name_key`);
--> statement-breakpoint
ALTER TABLE `media_groups` ADD `source_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `media_groups_library_source_key` ON `media_groups` (`library_id`,`source_key`);
--> statement-breakpoint
ALTER TABLE `channels` ADD `number_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_number_key_unique` ON `channels` (`number_key`);
--> statement-breakpoint
ALTER TABLE `scheduling_programs` ADD `name_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_programs_name_key_unique` ON `scheduling_programs` (`name_key`);
--> statement-breakpoint
ALTER TABLE `schedule_templates` ADD `name_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_templates_name_key_unique` ON `schedule_templates` (`name_key`);
--> statement-breakpoint
CREATE TABLE `catalog_conflicts` (
	`library_id` text NOT NULL,
	`conflict_key` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text,
	`external_id` text,
	`paths` text NOT NULL,
	`message` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_conflicts_library_key` ON `catalog_conflicts` (`library_id`,`conflict_key`);
--> statement-breakpoint
CREATE INDEX `catalog_conflicts_library_idx` ON `catalog_conflicts` (`library_id`);
