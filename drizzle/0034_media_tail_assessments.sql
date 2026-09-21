CREATE TABLE `media_tail_assessments` (
  `library_id` text NOT NULL REFERENCES `libraries`(`id`) ON DELETE cascade,
  `relative_path` text NOT NULL,
  `fingerprint` text NOT NULL,
  `result` text NOT NULL,
  `accepted` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_tail_assessments_file` ON `media_tail_assessments` (`library_id`, `relative_path`);
