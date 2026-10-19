import { z } from 'zod';

/** Maximum accepted compressed archive size (64 GiB). */
export const BACKUP_MAX_BYTES = 64 * 1024 ** 3;
/** Maximum total extracted content (128 GiB). */
export const BACKUP_MAX_EXPANDED_BYTES = 128 * 1024 ** 3;
/** Maximum files in one configuration archive. */
export const BACKUP_MAX_ENTRIES = 100_000;
/** Upgrade recovery retention is independent of automatic retention. */
export const UPGRADE_BACKUP_RETENTION = 3;
/** Saved automatic backup policy; runtime scheduling state is stored separately. */
export const backupSettingsSchema = z.object({
	enabled: z.boolean().default(true),
	intervalDays: z.number().int().min(1).max(3650).default(1),
	retention: z.number().int().min(1).max(1000).default(7),
});
/** Administrator-controlled automatic backup settings. */
export type BackupSettings = z.infer<typeof backupSettingsSchema>;
/** Categories have independent retention rules. */
export const backupKindSchema = z.enum(['automatic', 'manual', 'pre-restore', 'upgrade']);
/** One completed archive available for download, restore, or deletion. */
export const backupInfoSchema = z.object({
	id: z.uuid(), createdAt: z.iso.datetime(), kind: backupKindSchema,
	applicationVersion: z.string(), size: z.number().nonnegative(),
});
/** Completed archive metadata without filesystem paths. */
export type BackupInfo = z.infer<typeof backupInfoSchema>;
/** Name archives with their UTC creation timestamp and identity for sortable, collision-safe storage. */
export function backupFilename(backup: Pick<BackupInfo, 'id' | 'createdAt'>): string {
	return `moirai-${new Date(backup.createdAt).toISOString().replaceAll(':', '-')}-${backup.id}.zip`;
}
/** A recognized archive whose metadata cannot be read; deletion remains available by identity. */
export const damagedBackupSchema = z.object({ id: z.uuid(), name: z.string() });
/** Unreadable archive listed separately from validated backup metadata. */
export type DamagedBackup = z.infer<typeof damagedBackupSchema>;
/** Snapshot of backup progress and scheduling, including persistent failures. */
export const backupStatusSchema = z.object({
	settings: backupSettingsSchema, backups: z.array(backupInfoSchema), directory: z.string(),
	damagedBackups: z.array(damagedBackupSchema).optional(),
	timeZone: z.string(), nextRun: z.string().nullable(), busy: z.string().nullable(),
	error: z.string().nullable(),
});
/** Settings panel status response. */
export type BackupStatus = z.infer<typeof backupStatusSchema>;
/** Validated restore preview is bound to a private staged archive. */
export const backupReviewSchema = z.object({
	id: z.uuid(), backup: backupInfoSchema, libraries: z.number(), channels: z.number(), mediaItems: z.number(),
});
/** Summary shown before replacing configuration. */
export type BackupReview = z.infer<typeof backupReviewSchema>;

/** Stable validation categories returned without archive contents or raw database errors. */
export const backupValidationCodeSchema = z.enum([
	'backup_invalid_archive', 'backup_unsupported_schema', 'backup_invalid_records', 'backup_invalid_assets',
]);
/** Safe validation failure category shared by workers, HTTP responses, and the restore dialog. */
export type BackupValidationCode = z.infer<typeof backupValidationCodeSchema>;
/** Actionable explanations for each supported restore-validation failure. */
export const BACKUP_VALIDATION_MESSAGES: Record<BackupValidationCode, string> = {
	backup_invalid_archive: 'The backup ZIP is malformed, incomplete, or failed an integrity check. Try another backup or export it again.',
	backup_unsupported_schema: 'The backup has an unsupported database migration history. Update Moirai or choose a compatible backup.',
	backup_invalid_records: 'The backup contains incompatible or invalid configuration records. Try another backup and check the server logs using the request ID.',
	backup_invalid_assets: 'An uploaded image or fallback video in the backup failed validation. Check the media inspector and try another backup.',
};
