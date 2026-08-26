ALTER TABLE `media_items` ADD `file_modified_at` text;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `date_added_at` text;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `title_bucket` text NOT NULL DEFAULT '#';
--> statement-breakpoint
UPDATE `media_items`
SET `date_added_at` = `created_at`,
    `title_bucket` = CASE
      WHEN upper(substr(ltrim(`sort_title`), 1, 1)) BETWEEN 'A' AND 'Z'
        THEN upper(substr(ltrim(`sort_title`), 1, 1))
      ELSE '#'
    END;
--> statement-breakpoint
CREATE INDEX `media_items_library_added_idx` ON `media_items` (`library_id`, `date_added_at`);
--> statement-breakpoint
CREATE INDEX `media_items_library_bucket_idx` ON `media_items` (`library_id`, `title_bucket`);
--> statement-breakpoint
CREATE TABLE `media_item_genres` (
  `item_id` text NOT NULL REFERENCES `media_items`(`id`) ON DELETE cascade,
  `library_id` text NOT NULL REFERENCES `libraries`(`id`) ON DELETE cascade,
  `genre_key` text NOT NULL,
  `genre_name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_item_genres_item_key` ON `media_item_genres` (`item_id`, `genre_key`);
--> statement-breakpoint
CREATE INDEX `media_item_genres_library_key_idx` ON `media_item_genres` (`library_id`, `genre_key`, `item_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `media_item_genres` (`item_id`, `library_id`, `genre_key`, `genre_name`)
SELECT
  `media_items`.`id`,
  `media_items`.`library_id`,
  CASE lower(replace(replace(trim(CAST(`genre`.`value` AS text)), '-', ' '), '_', ' '))
    WHEN 'sci fi' THEN 'science-fiction'
    WHEN 'scifi' THEN 'science-fiction'
    WHEN 'science fiction' THEN 'science-fiction'
    WHEN 'film noir' THEN 'film-noir'
    ELSE lower(replace(replace(trim(CAST(`genre`.`value` AS text)), ' ', '-'), '_', '-'))
  END,
  CASE lower(replace(replace(trim(CAST(`genre`.`value` AS text)), '-', ' '), '_', ' '))
    WHEN 'sci fi' THEN 'Science Fiction'
    WHEN 'scifi' THEN 'Science Fiction'
    WHEN 'science fiction' THEN 'Science Fiction'
    WHEN 'film noir' THEN 'Film Noir'
    ELSE trim(CAST(`genre`.`value` AS text))
  END
FROM `media_items`, json_each(`media_items`.`metadata`, '$.genres') AS `genre`
WHERE trim(CAST(`genre`.`value` AS text)) <> '';
--> statement-breakpoint
CREATE TABLE `media_item_people` (
  `item_id` text NOT NULL REFERENCES `media_items`(`id`) ON DELETE cascade,
  `library_id` text NOT NULL REFERENCES `libraries`(`id`) ON DELETE cascade,
  `person_type` text NOT NULL,
  `name` text NOT NULL,
  `normalized_name` text NOT NULL,
  `role` text,
  `sort_order` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_item_people_item_type_name` ON `media_item_people` (`item_id`, `person_type`, `normalized_name`);
--> statement-breakpoint
CREATE INDEX `media_item_people_library_type_name_idx` ON `media_item_people` (`library_id`, `person_type`, `normalized_name`, `item_id`);
