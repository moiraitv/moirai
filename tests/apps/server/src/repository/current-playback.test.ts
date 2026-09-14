import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { channelCreateSchema, libraryCreateSchema, type SchedulableMedia } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { materializedTimelineSegments, mediaItems } from '@server/db/schema.js';
import { Repository } from '@server/repository/index.js';

it('enriches legacy music snapshots while preserving captured credits and time boundaries', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Music' }));
		const library = await repository.createLibrary(libraryCreateSchema.parse({ name: 'Music', typeKey: 'music-videos', sourceType: 'on-disk', sourceConfig: { scanRoot: '/music' } }));
		const id = randomUUID();
		const start = '2026-09-14T01:00:00.000Z';
		const finish = '2026-09-14T02:00:00.000Z';
		await database.db.insert(mediaItems).values({
			id, libraryId: library.id, stableKey: 'song', kind: 'music-video', title: 'Song', sortTitle: 'Song', relativePath: 'song.mp4', playbackPath: '/music/song.mp4',
			artists: ['Catalog artist'], metadataStatus: 'complete', metadata: {}, fingerprint: 'fixture', dateAddedAt: start, createdAt: start, updatedAt: start,
		});
		const snapshot = { id, libraryId: library.id, kind: 'music-video', title: 'Song', artworkUrl: null } as SchedulableMedia;
		const segmentId = randomUUID();
		await database.db.insert(materializedTimelineSegments).values({
			id: segmentId, channelId: channel.id, templateId: 'template', slotId: 'slot', mediaItemId: id,
			role: 'primary', title: 'Song', playbackPath: '/music/song.mp4', startsAt: start, finishesAt: finish,
			sourceStartSeconds: 0, sourceFinishSeconds: 3600, truncated: false, mediaSnapshot: snapshot, stateDelta: [],
		});
		expect((await repository.listCurrentPlaybackSegments(start))[0]?.mediaSnapshot?.artists).toEqual(['Catalog artist']);
		expect(await repository.listCurrentPlaybackSegments(finish)).toEqual([]);
		expect(await repository.listCurrentPlaybackSegments('2026-09-14T00:59:59.999Z')).toEqual([]);
		await database.db.update(materializedTimelineSegments).set({ mediaSnapshot: { ...snapshot, artists: ['Captured artist'] } }).where(eq(materializedTimelineSegments.id, segmentId));
		expect((await repository.listCurrentPlaybackSegments(start))[0]?.mediaSnapshot?.artists).toEqual(['Captured artist']);
		await database.db.delete(mediaItems).where(eq(mediaItems.id, id));
		expect((await repository.listCurrentPlaybackSegments(start))[0]?.mediaSnapshot?.artists).toEqual(['Captured artist']);
	}
	finally {
		database.close();
	}
});
