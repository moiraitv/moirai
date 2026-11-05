ALTER TABLE schedule_templates ADD COLUMN graphics_assignment text;
--> statement-breakpoint
ALTER TABLE schedule_slots ADD COLUMN graphics_assignment text;
--> statement-breakpoint
ALTER TABLE materialized_timeline_segments ADD COLUMN filler_preset_id text;
