CREATE TABLE `selection_states_next` (
  `consumer_key` text PRIMARY KEY NOT NULL,
  `channel_id` text NOT NULL REFERENCES `channels`(`id`) ON DELETE cascade,
  `config_fingerprint` text NOT NULL,
  `value` text NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `selection_states_next` (
  `consumer_key`,
  `channel_id`,
  `config_fingerprint`,
  `value`,
  `updated_at`
)
SELECT
  `consumer_key`,
  substr(`consumer_key`, instr(`consumer_key`, ':') + 1, 36),
  `config_fingerprint`,
  `value`,
  `updated_at`
FROM `selection_states`
WHERE EXISTS (
  SELECT 1
  FROM `channels`
  WHERE `channels`.`id` = substr(`selection_states`.`consumer_key`, instr(`selection_states`.`consumer_key`, ':') + 1, 36)
);
--> statement-breakpoint
DROP TABLE `selection_states`;
--> statement-breakpoint
ALTER TABLE `selection_states_next` RENAME TO `selection_states`;
--> statement-breakpoint
CREATE INDEX `selection_states_channel_idx` ON `selection_states` (`channel_id`);
