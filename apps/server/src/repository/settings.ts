import { eq } from 'drizzle-orm';
import type { PlaybackSettings } from '@moirai/shared';
import { backupSettingsSchema, type BackupSettings, playbackSettingsSchema } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { settings } from '../db/schema.js';
import { currentTimestamp } from '../time.js';

/**
 * Own application-wide playback and automatic backup configuration. Parse stored values
 * through shared schemas and supply safe defaults when no settings have been persisted.
 */
export class SettingsRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** Return persisted playback settings or safe defaults. */
	async getPlaybackSettings(): Promise<PlaybackSettings> {
		const [row] = await this.db.select().from(settings).where(eq(settings.key, 'playback'));
		return row ? playbackSettingsSchema.parse(row.value) : playbackSettingsSchema.parse({});
	}

	/** Return the saved automatic backup policy or installation defaults. */
	async getBackupSettings(): Promise<BackupSettings> {
		const [row] = await this.db.select().from(settings).where(eq(settings.key, 'backups'));
		return backupSettingsSchema.parse(row?.value ?? {});
	}

	/** Persist automatic backup policy through the existing single writer. */
	async setBackupSettings(value: BackupSettings): Promise<BackupSettings> {
		await this.db.insert(settings).values({ key: 'backups', value, updatedAt: currentTimestamp() })
			.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: currentTimestamp() } });
		return value;
	}

	/** Persist validated playback settings. */
	async setPlaybackSettings(value: PlaybackSettings): Promise<PlaybackSettings> {
		const updatedAt = currentTimestamp();

		await this.db
			.insert(settings)
			.values({ key: 'playback', value, updatedAt })
			.onConflictDoUpdate({
				target: settings.key,
				set: { value, updatedAt },
			});
		return value;
	}
}
