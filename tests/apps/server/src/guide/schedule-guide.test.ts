import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import type { ChannelSchedule, TimelineSegment } from '@moirai/shared';
import type { Repository } from '@server/repository/index.js';
import {
	boundedGuideWindow,
	CommittedGuideUnavailableError,
	readCommittedScheduleGuide,
} from '@server/guide/schedule-guide.js';

const START_DATE = '2026-08-23';
const RANGE_START = '2026-08-23T00:00:00Z';
const RANGE_END = '2026-08-24T00:00:00Z';

/** Build a minimal configured channel schedule for committed-guide tests. */
function schedule(channelId = randomUUID()): ChannelSchedule {
	return {
		channelId,
		defaultTemplateId: randomUUID(),
		layers: [],
		defaultFiller: null,
		createdAt: RANGE_START,
		updatedAt: RANGE_START,
	};
}

/** Build a concrete dead-air segment that covers the supplied range. */
function segment(channelId: string, start = RANGE_START, finish = RANGE_END): TimelineSegment {
	return {
		id: randomUUID(),
		role: 'dead-air',
		channelId,
		scheduleLayerId: null,
		templateId: randomUUID(),
		slotId: randomUUID(),
		programId: null,
		mediaItemId: null,
		title: 'No programming',
		playbackPath: null,
		start,
		finish,
		sourceStartSeconds: 0,
		sourceFinishSeconds: null,
		truncated: false,
	};
}

/** Build the repository methods used by committed guide reads. */
function repositoryFixture(
	schedules: ChannelSchedule[],
	segments: TimelineSegment[],
	statuses: Array<{
		channelId: string;
		health: 'ready' | 'pending' | 'failed';
		committedAt: string | null;
	}>,
): Repository {
	return {
		listChannelSchedules: vi.fn().mockResolvedValue(schedules),
		listMaterializedTimelineSegments: vi.fn().mockResolvedValue(
			segments.map((entry) => ({ segment: entry, mediaSnapshot: null, stateDelta: [] })),
		),
		listMaterializedTimelineSegmentsForGuide: vi.fn().mockResolvedValue(
			segments.map((entry) => ({ segment: entry, mediaSnapshot: null, stateDelta: [] })),
		),
		getSchedulingCatalog: vi.fn().mockResolvedValue({
			media: [],
			groupParents: {},
			libraryAvailability: {},
			groupTitles: {},
			libraryNames: {},
		}),
		listTimelineMaterializations: vi.fn().mockResolvedValue(
			statuses.map((status) => ({
				...status,
				windowStart: RANGE_START,
				windowEnd: RANGE_END,
				continuationAt: RANGE_END,
				inputFingerprint: 'fixture',
				baseState: [],
				issues: [],
				pendingSince: null,
				applyAfter: null,
				lastError: status.health === 'failed' ? 'failed' : null,
			})),
		),
	} as unknown as Repository;
}

describe('readCommittedScheduleGuide', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('accepts complete pending timelines and reports the oldest channel commit', async () => {
		const first = schedule();
		const second = schedule();
		const repository = repositoryFixture(
			[first, second],
			[segment(first.channelId), segment(second.channelId)],
			[
				{ channelId: first.channelId, health: 'pending', committedAt: '2026-08-23T00:02:00Z' },
				{ channelId: second.channelId, health: 'ready', committedAt: '2026-08-23T00:01:00Z' },
			],
		);

		const result = await readCommittedScheduleGuide(repository, 'UTC', START_DATE, 1);

		expect(result.guide.committedAt).toBe('2026-08-23T00:01:00Z');
		expect(result.guide).toMatchObject({
			requestedDays: 1,
			days: 1,
			segmentLimitApplied: false,
		});
		expect(result.guide.channels).toHaveLength(2);
	});

	it('shortens an oversized response before the overflow day', () => {
		const channelId = randomUUID();
		const records = [
			segment(channelId, '2026-08-23T00:00:00Z', '2026-08-23T12:00:00Z'),
			segment(channelId, '2026-08-23T12:00:00Z', '2026-08-24T00:00:00Z'),
			segment(channelId, '2026-08-24T00:00:00Z', '2026-08-24T12:00:00Z'),
		].map((entry) => ({ segment: entry, mediaSnapshot: null, stateDelta: [] }));

		const result = boundedGuideWindow(
			Temporal.PlainDate.from('2026-08-23'),
			Temporal.PlainDate.from('2026-08-25'),
			'UTC',
			records,
			2,
		);

		expect(result).toMatchObject({ days: 1, segmentLimitApplied: true });
		expect(result.rows).toHaveLength(2);
		expect(result.endDate.toString()).toBe('2026-08-24');
	});

	it.each([
		['a failed materialization', 'failed' as const, [segment(randomUUID())]],
		['a gap in committed segments', 'ready' as const, []],
	])('rejects %s', async (_label, health, suppliedSegments) => {
		const configured = schedule();
		const segments = suppliedSegments.map((entry) => ({ ...entry, channelId: configured.channelId }));
		const repository = repositoryFixture(
			[configured],
			segments,
			[{ channelId: configured.channelId, health, committedAt: '2026-08-23T00:01:00Z' }],
		);

		await expect(readCommittedScheduleGuide(repository, 'UTC', START_DATE, 1)).rejects.toBeInstanceOf(
			CommittedGuideUnavailableError,
		);
	});
});
