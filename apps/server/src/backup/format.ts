import path from 'node:path';
import { z } from 'zod';
import { backupInfoSchema, BACKUP_MAX_ENTRIES } from '@moirai/shared';
import type { AppConfig } from '../config.js';

/** Explicit durable table ownership; caches and all authentication tables are excluded. */
export const BACKUP_TABLES = [
	'libraries', 'media_groups', 'catalog_conflicts', 'media_items', 'media_item_aliases',
	'media_item_genres', 'media_item_people', 'viewing_preference_events', 'media_removal_tombstones',
	'channels', 'scheduling_programs', 'schedule_templates', 'schedule_slots', 'schedule_boundaries',
	'channel_schedules', 'channel_schedule_layers', 'selection_states', 'settings', 'credit_templates',
	'encoding_profiles', 'guide_templates', 'ignored_media_issues', 'media_tail_assessments', 'filler_presets', 'mid_roll_presets',
	'similarity_seeds', 'similarity_seed_items',
] as const;
/** Schema-level archive identity, independent of application version. */
export const manifestSchema = backupInfoSchema.omit({ size: true }).extend({
	formatVersion: z.literal(1),
	migrations: z.array(z.object({ createdAt: z.number(), hash: z.string() })).max(10_000),
	tables: z.array(z.enum(BACKUP_TABLES)).max(BACKUP_TABLES.length),
	entries: z.array(z.object({ name: z.string().max(300), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).max(BACKUP_MAX_ENTRIES),
});
/** Validated portable archive manifest. */
export type BackupManifest = z.infer<typeof manifestSchema>;
/** Runtime-only paths passed into the archive worker. */
export type BackupPaths = Pick<AppConfig, 'databasePath' | 'dataDir' | 'channelLogoDir' | 'fallbackFillerDir' | 'migrationsDir' | 'ffprobePath'>;
/** Export a fixed logical namespace without embedding deployment paths in archives. */
export function assetRoots(config: BackupPaths): Record<string, string> {
	return {
		'channel-logos': config.channelLogoDir,
		'guide-artwork': path.join(config.dataDir, 'guide-artwork'),
		'fallback-fillers': config.fallbackFillerDir,
	};
}
/** Accept only durable records and managed current assets, never arbitrary filesystem paths. */
export function allowedEntry(name: string): boolean {
	if (name === 'manifest.json' || name === 'ai-settings.json'
		|| BACKUP_TABLES.some(table => name === `tables/${table}.ndjson`)) {
		return true;
	}
	const parts = name.split('/');
	if (parts.length === 2 && ['channel-logos', 'guide-artwork'].includes(parts[0]!)) {
		return parts[1]!.endsWith('.png') && z.uuid().safeParse(parts[1]!.slice(0, -4)).success;
	}
	if (parts[0] !== 'fallback-fillers') {
		return false;
	}
	const suffix = parts[1] === 'global' ? parts.slice(2)
		: parts[1] === 'channels' && z.uuid().safeParse(parts[2]).success ? parts.slice(3) : [];
	return suffix.length === 2 && suffix[0] === 'current' && ['asset', 'metadata.json'].includes(suffix[1]!);
}
