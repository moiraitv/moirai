CREATE TABLE `guide_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`description` text NOT NULL DEFAULT '',
	`sources` text NOT NULL,
	`is_builtin` integer NOT NULL DEFAULT 0,
	`is_default` integer NOT NULL DEFAULT 0,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guide_templates_name_key_unique` ON `guide_templates` (`name_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `guide_templates_one_default` ON `guide_templates` (`is_default`) WHERE `is_default` = 1;
--> statement-breakpoint
INSERT INTO `guide_templates` (`id`, `name`, `name_key`, `description`, `sources`, `is_builtin`, `is_default`)
VALUES (
	'20000000-0000-4000-8000-000000000002',
	'Standard XMLTV',
	'standard xmltv',
	'The current Moirai XMLTV channel and programme layout.',
	'{}',
	1,
	1
);
