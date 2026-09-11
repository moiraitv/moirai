ALTER TABLE schedule_slots ADD COLUMN guide TEXT NOT NULL DEFAULT '{"mode":"items"}';
--> statement-breakpoint
ALTER TABLE schedule_templates ADD COLUMN scheduling_updated_at TEXT;
--> statement-breakpoint
UPDATE schedule_templates SET scheduling_updated_at = updated_at;
--> statement-breakpoint
ALTER TABLE timeline_materializations ADD COLUMN guide_occurrences TEXT NOT NULL DEFAULT '[]';
