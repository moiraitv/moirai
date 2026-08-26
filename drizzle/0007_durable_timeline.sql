CREATE TABLE `timeline_materializations` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`continuation_at` text NOT NULL,
	`input_fingerprint` text NOT NULL,
	`base_state` text NOT NULL,
	`issues` text NOT NULL,
	`committed_at` text NOT NULL,
	`pending_since` text,
	`apply_after` text,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `materialized_timeline_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`schedule_layer_id` text,
	`template_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`program_id` text,
	`media_item_id` text,
	`role` text NOT NULL,
	`title` text NOT NULL,
	`playback_path` text,
	`starts_at` text NOT NULL,
	`finishes_at` text NOT NULL,
	`source_start_seconds` integer NOT NULL,
	`source_finish_seconds` integer,
	`truncated` integer NOT NULL,
	`media_snapshot` text,
	`state_delta` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `materialized_segments_channel_start_idx` ON `materialized_timeline_segments` (`channel_id`,`starts_at`);
--> statement-breakpoint
CREATE INDEX `materialized_segments_channel_finish_idx` ON `materialized_timeline_segments` (`channel_id`,`finishes_at`);
