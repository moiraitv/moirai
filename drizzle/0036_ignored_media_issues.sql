CREATE TABLE `ignored_media_issues` (
  `library_id` text NOT NULL REFERENCES `libraries`(`id`) ON DELETE CASCADE,
  `relative_path` text NOT NULL,
  `code` text NOT NULL,
  `fingerprint` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ignored_media_issues_key` ON `ignored_media_issues` (`library_id`, `relative_path`, `code`);
--> statement-breakpoint
INSERT INTO `ignored_media_issues` (`library_id`, `relative_path`, `code`, `fingerprint`)
SELECT `library_id`, `relative_path`, 'media_audio_video_duration_mismatch', `fingerprint`
FROM `media_tail_assessments` WHERE `accepted` = 1;
