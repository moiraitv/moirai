import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { CREDIT_PREVIEW_VIDEO_LIMIT, creditPreviewSchema, encodingProfileCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { libraries, mediaItems } from '@server/db/schema.js';
import { CreditTemplateRepository } from '@server/repository/credit-templates.js';
import { EncodingProfileRepository } from '@server/repository/encoding-profiles.js';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));

it('bounds available music video samples across libraries and maps persisted durations', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	const { db } = database;
	const libraryIds = [randomUUID(), randomUUID()];
	for (const id of libraryIds) {
		db.insert(libraries).values({ id, name: id, typeKey: 'music-videos', sourceType: 'local', sourceConfig: { scanRoot: '/media', playbackRoot: null } }).run();
	}
	for (let index = 0; index < CREDIT_PREVIEW_VIDEO_LIMIT + 3; index++) {
		const id = randomUUID();
		db.insert(mediaItems).values({ id, libraryId: libraryIds[index % 2]!, stableKey: id,
			kind: index === 0 ? 'movie' : 'music-video', availability: index === 1 ? 'unconfirmed' : 'available',
			title: String(index), sortTitle: String(index), relativePath: id, playbackPath: `/media/${id}`,
			metadataStatus: 'complete', metadata: {}, fingerprint: id, dateAddedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`, durationMilliseconds: 60000 }).run();
	}
	const rows = await new CreditTemplateRepository(db).previewVideos();
	expect(rows).toHaveLength(CREDIT_PREVIEW_VIDEO_LIMIT);
	expect(rows.every(row => row.kind === 'music-video' && row.availability === 'available' && row.durationSeconds === 60)).toBe(true);
	expect(new Set(rows.map(row => row.libraryId)).size).toBe(2);
	expect(rows.map(row => Number(row.title))).toEqual(Array.from({ length: CREDIT_PREVIEW_VIDEO_LIMIT }, (_, index) => CREDIT_PREVIEW_VIDEO_LIMIT + 2 - index));
});

it('uses the saved default profile without channels and accepts channel-free preview requests', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	const profiles = new EncodingProfileRepository(database.db);
	const custom = encodingProfileCreateSchema.parse({ name: 'Preview default', video: { width: 1280, height: 720, scalingMode: 'crop' }, audio: { channels: 1 } });
	const saved = await profiles.save(custom);
	await profiles.setDefault(saved.profile.id);
	expect(profiles.getDefault()).toEqual(custom);
	expect(creditPreviewSchema.parse({ source: 'test', mediaItemId: randomUUID() })).not.toHaveProperty('channelId');
});
