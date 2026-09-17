import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, it } from 'vitest';
import { channelCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';

it('includes a still-playing item that started before the requested guide range', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Overnight' }));
		const rangeStart = '2026-08-23T00:00:00Z';
		const rangeEnd = '2026-08-24T00:00:00Z';
		const playingStart = '2026-08-22T22:00:00Z';
		const playingFinish = '2026-08-23T02:00:00Z';
		repository.commitMaterializedTimeline({
			channelId: channel.id,
			windowStart: playingStart,
			windowEnd: rangeEnd,
			replaceFrom: playingStart,
			continuationAt: rangeEnd,
			inputFingerprint: 'fixture',
			baseState: [],
			finalState: [],
			issues: [],
			committedAt: playingStart,
			segments: [
				{
					segment: {
						id: randomUUID(),
						channelId: channel.id,
						templateId: 'template',
						slotId: 'slot',
						scheduleLayerId: null,
						programId: null,
						mediaItemId: null,
						role: 'primary',
						title: 'Ended before the window',
						playbackPath: null,
						playbackParts: [],
						start: '2026-08-22T20:00:00Z',
						finish: rangeStart,
						sourceStartSeconds: 0,
						sourceFinishSeconds: 7200,
						truncated: false,
					},
					mediaSnapshot: null,
					stateDelta: [],
					continuation: null,
				},
				{
					segment: {
						id: randomUUID(),
						channelId: channel.id,
						templateId: 'template',
						slotId: 'slot',
						scheduleLayerId: null,
						programId: null,
						mediaItemId: null,
						role: 'primary',
						title: 'Still playing',
						playbackPath: null,
						playbackParts: [],
						start: playingStart,
						finish: playingFinish,
						sourceStartSeconds: 0,
						sourceFinishSeconds: 14400,
						truncated: false,
					},
					mediaSnapshot: null,
					stateDelta: [],
					continuation: null,
				},
				{
					segment: {
						id: randomUUID(),
						channelId: channel.id,
						templateId: 'template',
						slotId: 'slot',
						scheduleLayerId: null,
						programId: null,
						mediaItemId: null,
						role: 'dead-air',
						title: 'Starts at the window end',
						playbackPath: null,
						playbackParts: [],
						start: rangeEnd,
						finish: '2026-08-24T01:00:00Z',
						sourceStartSeconds: 0,
						sourceFinishSeconds: 3600,
						truncated: false,
					},
					mediaSnapshot: null,
					stateDelta: [],
					continuation: null,
				},
			],
		});

		const rows = await repository.listMaterializedTimelineSegmentsForGuide(
			rangeStart,
			rangeEnd,
			10,
			[channel.id],
		);
		expect(rows.map((row) => row.segment.title)).toEqual(['Still playing']);
		expect(rows[0]?.segment.start).toBe(playingStart);
		expect(rows[0]?.segment.finish).toBe(playingFinish);
	}
	finally {
		database.close();
	}
});
