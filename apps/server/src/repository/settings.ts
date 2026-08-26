import { eq } from 'drizzle-orm';
import type { PlaybackSettings } from '@moirai/shared';
import { playbackSettingsSchema } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { settings } from '../db/schema.js';
import { currentTimestamp } from '../time.js';

/**
 * Own the singleton application-wide playback configuration. This repository parses stored values
 * through the shared schema and supplies safe defaults when no settings have been persisted.
 */
export class SettingsRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** Return persisted playback settings or safe defaults. */
	async getPlaybackSettings(): Promise<PlaybackSettings> {
		const [row] = await this.db.select().from(settings).where(eq(settings.key, 'playback'));
		return row ? playbackSettingsSchema.parse(row.value) : playbackSettingsSchema.parse({});
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
