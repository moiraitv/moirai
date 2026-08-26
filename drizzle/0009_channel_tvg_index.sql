ALTER TABLE `channels` ADD `effective_tvg_id` text;
--> statement-breakpoint
UPDATE `channels`
SET `effective_tvg_id` = 'C' || `number` || '.' || SUBSTR(`id`, 1, 8) || '.moirai.tv';
--> statement-breakpoint
CREATE INDEX `channels_effective_tvg_id_idx` ON `channels` (`effective_tvg_id`);
