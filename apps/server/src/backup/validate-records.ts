import type Database from 'better-sqlite3';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { scheduleTemplates, scheduleSlots, scheduleBoundaries } from '../db/schema.js';
import {
	channelCreateSchema, programConfigSchema, encodingProfileCreateSchema, channelScheduleConfigSchema,
	fillerPresetCreateSchema, midRollPresetCreateSchema, guideTemplateSourcesSchema,
	onDiskSourceConfigSchema, sourceIdentitySchema, scheduleTemplateCreateSchema,
} from '@moirai/shared';

/** Validate configuration payloads after historical migrations have supplied current defaults. */
export function validateConfigurationRecords(sqlite: Database.Database): void {
	const configurations: Array<[string, string, z.ZodType]> = [
		['channels', 'config', channelCreateSchema],
		['scheduling_programs', 'config', programConfigSchema],
		['encoding_profiles', 'config', encodingProfileCreateSchema],
		['channel_schedules', 'config', channelScheduleConfigSchema],
		['guide_templates', 'sources', guideTemplateSourcesSchema],
		['libraries', 'source_config', onDiskSourceConfigSchema],
	];
	for (const [table, column, schema] of configurations) {
		for (const row of sqlite.prepare(`SELECT "${column}" AS value FROM "${table}"`).iterate() as Iterable<{ value: string }>) {
			schema.parse(JSON.parse(row.value));
		}
	}
	validateScheduleTemplates(sqlite);
	for (const row of sqlite.prepare('SELECT kind,config FROM filler_presets').iterate() as Iterable<{ kind: string; config: string }>) {
		(row.kind === 'mid-roll' ? midRollPresetCreateSchema : fillerPresetCreateSchema).parse(JSON.parse(row.config));
	}
	for (const row of sqlite.prepare('SELECT accepted_source_identity AS identity FROM libraries WHERE accepted_source_identity IS NOT NULL').iterate() as Iterable<{ identity: string }>) {
		sourceIdentitySchema.parse(JSON.parse(row.identity));
	}
}

/** Parse authored schedule JSON through the same columns and shared contracts used by editors. */
function validateScheduleTemplates(sqlite: Database.Database): void {
	const db = drizzle(sqlite);
	const templates = db.select().from(scheduleTemplates).all();
	const slots = db.select().from(scheduleSlots).all();
	const boundaries = db.select().from(scheduleBoundaries).all();
	for (const template of templates) {
		scheduleTemplateCreateSchema.parse({
			...template,
			slots: slots.filter(slot => slot.templateId === template.id),
			boundaries: boundaries.filter(boundary => boundary.templateId === template.id),
		});
	}
}
