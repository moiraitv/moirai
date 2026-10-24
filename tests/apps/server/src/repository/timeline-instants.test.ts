import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { and, eq, lte, sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { channelCreateSchema, type TimelineAiring } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { instantMilliseconds } from '@server/db/instant.js';
import { materializedTimelineSegments } from '@server/db/schema.js';
import { Repository, type MaterializedSegmentRecord, type TimelineCommit } from '@server/repository/index.js';

const midnight = '2026-08-23T00:00:00Z';
const overlap = '2026-08-23T00:00:00.71Z';
const end = '2026-08-23T00:00:01Z';
let database: ReturnType<typeof createDatabase>;
let repository: Repository;
let channelId: string;

beforeEach(async () => {
	database = createDatabase(':memory:', path.resolve('drizzle'));
	repository = new Repository(database.db);
	channelId = (await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Midnight' }))).id;
});

afterEach(() => database.close());

function record(start: string, finish: string, airing?: TimelineAiring): MaterializedSegmentRecord {
	return {
		segment: {
			id: randomUUID(), channelId, templateId: 'template', slotId: 'slot', scheduleLayerId: null,
			programId: null, mediaItemId: randomUUID(), role: 'primary', title: 'Clip',
			playbackPath: '/media/clip.mp4', playbackParts: [], start, finish,
			sourceStartSeconds: 0, sourceFinishSeconds: (Date.parse(finish) - Date.parse(start)) / 1_000,
			truncated: false, ...(airing ? { airing } : {}),
		},
		mediaSnapshot: null, stateDelta: [], continuation: null,
	};
}

function commit(segments: MaterializedSegmentRecord[], changes: Partial<TimelineCommit> = {}): void {
	repository.commitMaterializedTimeline({
		channelId, windowStart: '2026-08-22T00:00:00Z', windowEnd: end,
		replaceFrom: '2026-08-22T00:00:00Z', continuationAt: end,
		inputFingerprint: 'fixture', baseState: [], finalState: [], issues: [], committedAt: midnight,
		segments, ...changes,
	});
}

it.each([
	midnight,
	'2026-08-23T00:00:00.000Z',
	'2026-08-23T00:00:00.001Z',
	'2026-08-23T00:00:00.01Z',
	'2026-08-23T00:00:00.1Z',
	overlap,
	'2026-08-23T00:00:00.999Z',
	'2026-08-22T17:00:00.710-07:00',
	'1969-12-31T23:59:59.999Z',
])('converts %s to exact integer epoch milliseconds', (value) => {
	const result = database.db.get<{ milliseconds: number; storage: string }>(sql`
		SELECT ${instantMilliseconds(sql`${value}`)} AS milliseconds,
		typeof(${instantMilliseconds(sql`${value}`)}) AS storage
	`)!;
	expect(result).toEqual({ milliseconds: Date.parse(value), storage: 'integer' });
});

it('reads precise half-open intervals consistently for playback, occupancy, and both guide paths', async () => {
	const first = record('2026-08-22T23:59:59.9Z', overlap);
	const second = record('2026-08-23T00:00:00.710Z', end);
	commit([second, first]);

	for (const at of [midnight, '2026-08-23T00:00:00.709Z', '2026-08-22T17:00:00-07:00']) {
		expect((await repository.listCurrentPlaybackSegments(at)).map(row => row.segment.id)).toEqual([first.segment.id]);
	}
	expect((await repository.listCurrentPlaybackSegments(overlap)).map(row => row.segment.id)).toEqual([second.segment.id]);
	expect(await repository.listCurrentPlaybackSegments('2026-08-23T00:00:01.000Z')).toEqual([]);
	expect((await repository.listMaterializedTimelineSegments(midnight, overlap, channelId)).map(row => row.segment.id)).toEqual([first.segment.id]);
	expect((await repository.listMaterializedTimelineSegmentsForGuide(midnight, overlap, 10, [channelId])).map(row => row.segment.id)).toEqual([first.segment.id]);
	expect((await repository.listOccupiedMediaIntervals(midnight, overlap)).map(row => row.mediaItemId)).toEqual([first.segment.mediaItemId]);
	expect((await repository.listMaterializedTimelineSegments(overlap, end, channelId)).map(row => row.segment.id)).toEqual([second.segment.id]);
});

it('orders spans chronologically when zero and fractional seconds have different spellings', async () => {
	const first = record(midnight, overlap);
	const second = record(overlap, end);
	commit([second, first]);
	const ids = [first.segment.id, second.segment.id];
	expect((await repository.listMaterializedTimelineSegments(midnight, end, channelId)).map(row => row.segment.id)).toEqual(ids);
	expect((await repository.listMaterializedTimelineSegmentsForGuide(midnight, end, 10, [channelId])).map(row => row.segment.id)).toEqual(ids);
	// The guide budget must select the earliest span, rather than the earliest timestamp text.
	expect((await repository.listMaterializedTimelineSegmentsForGuide(midnight, end, 1, [channelId])).map(row => row.segment.id)).toEqual([first.segment.id]);
});

it('retains the midnight overlap and complete airing anchors until their exact finish', async () => {
	const start = '2026-08-22T23:59:59Z';
	const airing: TimelineAiring = { id: randomUUID(), primarySegmentId: randomUUID(), start, finish: overlap, truncated: false };
	const anchor = record(start, midnight, airing);
	anchor.segment.id = airing.primarySegmentId;
	const tail = record(midnight, overlap, airing);
	const next = record(overlap, end);
	commit([anchor, tail, next]);

	commit([], { windowStart: midnight, replaceFrom: '2026-08-23T00:00:01.000Z' });
	expect((await repository.getMaterializedTimelineSegment(channelId, anchor.segment.id))?.segment.airing).toEqual(airing);
	expect((await repository.listMaterializedTimelineSegments(midnight, end, channelId)).map(row => row.segment.id)).toEqual([tail.segment.id, next.segment.id]);

	commit([], { windowStart: '2026-08-23T00:00:00.710Z', replaceFrom: end });
	expect(await repository.getMaterializedTimelineSegment(channelId, anchor.segment.id)).toBeNull();
	expect(await repository.getMaterializedTimelineSegment(channelId, tail.segment.id)).toBeNull();
	expect((await repository.listMaterializedTimelineSegments(overlap, end, channelId)).map(row => row.segment.id)).toEqual([next.segment.id]);
});

it('keeps an ordinary midnight overlap and uses the numeric cleanup index', async () => {
	const first = record('2026-08-22T23:59:59Z', overlap);
	const next = record(overlap, end);
	commit([first, next]);
	commit([], { windowStart: midnight, replaceFrom: end });
	expect((await repository.listMaterializedTimelineSegments(midnight, end, channelId)).map(row => row.segment.id)).toEqual([first.segment.id, next.segment.id]);

	const query = database.db.select({ id: materializedTimelineSegments.id }).from(materializedTimelineSegments).where(and(
		eq(materializedTimelineSegments.channelId, channelId),
		lte(instantMilliseconds(sql`coalesce(json_extract(${materializedTimelineSegments.airing}, '$.finish'), ${materializedTimelineSegments.finishesAt})`), Date.parse(midnight)),
	)).toSQL();
	const plans = database.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{ detail: string }>;
	expect(plans.some(plan => plan.detail.includes('materialized_segments_channel_airing_finish_idx') && plan.detail.includes('<expr><?'))).toBe(true);
});

it('removes every replaced future span while retaining a span ending exactly at the boundary', async () => {
	const first = record('2026-08-22T23:59:59Z', midnight);
	const replaced = record(midnight, overlap);
	commit([first, replaced]);
	const replacement = record('2026-08-23T00:00:00.000Z', end);
	commit([replacement], { replaceFrom: midnight });
	expect(await repository.getMaterializedTimelineSegment(channelId, replaced.segment.id)).toBeNull();
	expect((await repository.listMaterializedTimelineSegments('2026-08-22T23:59:59Z', end, channelId)).map(row => row.segment.id)).toEqual([first.segment.id, replacement.segment.id]);
});
