import path from 'node:path';
import { expect, it } from 'vitest';
import { playbackSettingsSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { SettingsRepository } from '@server/repository/settings.js';

it('defaults legacy settings and persists warning tolerance alongside unrelated settings', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new SettingsRepository(database.db);
		expect((await repository.getPlaybackSettings()).fillerShortfallWarningThresholdPercent).toBe(80);
		database.sqlite.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('playback', JSON.stringify({ maxActiveSessions: 6, viewingPreferencesEnabled: false }), '2026-10-03T00:00:00Z');
		const legacy = await repository.getPlaybackSettings();
		expect(legacy).toEqual(playbackSettingsSchema.parse({ maxActiveSessions: 6, viewingPreferencesEnabled: false }));
		await repository.setPlaybackSettings({ ...legacy, fillerShortfallWarningThresholdPercent: 73 });
		const saved = await repository.getPlaybackSettings();
		await repository.setPlaybackSettings({ ...saved, maxActiveSessions: 8 });
		expect(await repository.getPlaybackSettings()).toEqual({ ...saved, maxActiveSessions: 8 });
	}
	finally {
		database.close();
	}
});
