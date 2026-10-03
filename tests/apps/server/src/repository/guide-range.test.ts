import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { channelCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { boundedGuideWindow } from '@server/guide/schedule-guide.js';
import { Temporal } from '@js-temporal/polyfill';

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

it('retains the primary guide anchor across midnight while an inserted break is playing', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Mid-roll' }));
		const start = '2026-08-22T23:50:00Z';
		const midnight = '2026-08-23T00:00:00Z';
		const breakEnd = '2026-08-23T00:02:00Z';
		const finish = '2026-08-23T00:20:00Z';
		const id = randomUUID();
		const airing = { id, primarySegmentId: id, start, finish, truncated: false };
		const segments = [start, midnight, breakEnd].map((spanStart, index) => ({
			segment: {
				id: index === 0 ? id : randomUUID(), channelId: channel.id, templateId: 'template', slotId: 'slot',
				scheduleLayerId: null, programId: null, mediaItemId: null,
				role: index === 1 ? 'filler' as const : 'primary' as const, title: 'Episode', playbackPath: null,
				playbackParts: [], start: spanStart, finish: [midnight, breakEnd, finish][index]!,
				sourceStartSeconds: 0, sourceFinishSeconds: 600, truncated: false, airing,
			}, mediaSnapshot: null, stateDelta: [], continuation: null,
		}));
		const commit = {
			channelId: channel.id, windowStart: start, windowEnd: finish, replaceFrom: start, continuationAt: finish,
			inputFingerprint: 'mid-roll', baseState: [], finalState: [], issues: [], committedAt: start, segments,
		};
		repository.commitMaterializedTimeline(commit);
		// Advancing the rolling window must keep the ended anchor until its entire airing finishes.
		repository.commitMaterializedTimeline({ ...commit, windowStart: midnight, replaceFrom: finish, segments: [] });
		const prepare = vi.spyOn(database.sqlite, 'prepare');
		const rows = await repository.listMaterializedTimelineSegmentsForGuide(midnight, breakEnd, 1, [channel.id]);
		const query = prepare.mock.calls.find(([query]) => query.includes('guide_window'))![0];
		const plans = database.sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(midnight, breakEnd, channel.id, 1, channel.id) as Array<{ detail: string }>;
		expect(plans.some(plan => plan.detail.includes('materialized_segments_channel_start_idx') && plan.detail.includes('starts_at<?'))).toBe(true);
		expect(plans.some(plan => plan.detail.includes('materialized_segments_channel_airing_id_idx') && plan.detail.includes('<expr>=?'))).toBe(true);
		prepare.mockRestore();
		expect(rows.map(row => row.segment.id)).toEqual(segments.map(row => row.segment.id));
		expect(rows[0]?.segment.airing).toEqual(airing);
		const bounded = boundedGuideWindow(Temporal.PlainDate.from('2026-08-23'), Temporal.PlainDate.from('2026-08-24'), 'UTC', rows, 2);
		expect(bounded.segmentLimitApplied).toBe(false);
		expect(bounded.rows).toHaveLength(3);
		repository.commitMaterializedTimeline({ ...commit, windowStart: finish, replaceFrom: finish, segments: [] });
		expect(await repository.listMaterializedTimelineSegmentsForGuide(start, finish, 10, [channel.id])).toEqual([]);
	}
	finally {
		database.close();
	}
});
