import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import type { ChannelSchedule, TimelineIssue, TimelineSegment } from '@moirai/shared';
import type { Repository } from '@server/repository/index.js';
import { recordTimelineIssue, type RecordedTimelineIssue } from '@server/scheduling/timeline-issues.js';
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
		issues?: TimelineIssue[];
		windowEnd?: string;
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
				windowEnd: status.windowEnd ?? RANGE_END,
				continuationAt: RANGE_END,
				inputFingerprint: 'fixture',
				baseState: [],
				issues: status.issues ?? [],
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

	it('keeps legacy issues visible until their materialized range is regenerated', async () => {
		const configured = schedule();
		const legacyIssue: TimelineIssue = {
			code: 'source-unavailable',
			message: 'A scheduled source was unavailable.',
			templateId: configured.defaultTemplateId,
			scheduleLayerId: null,
			slotId: randomUUID(),
			programId: randomUUID(),
			mediaItemId: null,
		};
		const repository = repositoryFixture(
			[configured],
			[segment(configured.channelId)],
			[{
				channelId: configured.channelId,
				health: 'ready',
				committedAt: '2026-08-23T00:01:00Z',
				issues: [legacyIssue],
			}],
		);

		const result = await readCommittedScheduleGuide(repository, 'UTC', START_DATE, 1);

		expect(result.guide.channels[0]?.preview.issues).toEqual([{
			...legacyIssue, occurrences: [], occurrenceCount: 1,
		}]);
	});

	it('returns diagnostic dates and boundary targets for a guide day beyond the retained detail sample', async () => {
		const configured = schedule();
		const issue: TimelineIssue = {
			code: 'boundary-start-rejected', message: 'A boundary could not be resolved.',
			templateId: configured.defaultTemplateId, scheduleLayerId: randomUUID(),
			slotId: randomUUID(), programId: randomUUID(), mediaItemId: null,
		};
		const issues: RecordedTimelineIssue[] = [];
		const seen = new Set<string>();
		const index = new Map<string, RecordedTimelineIssue>();
		const at = (hour: number): string => new Date(Date.parse(RANGE_START) + hour * 3600_000).toISOString();
		for (let hour = 0; hour < 168; hour += 1) {
			recordTimelineIssue(issues, seen, issue, {
				start: at(hour), finish: at(hour + 0.5), boundaryOrigin: 'layer-exit',
			}, index);
		}
		const repository = repositoryFixture(
			[configured],
			[segment(configured.channelId, at(72), at(96))],
			[{
				channelId: configured.channelId, health: 'ready', committedAt: RANGE_START,
				windowEnd: at(168), issues: JSON.parse(JSON.stringify(issues)) as RecordedTimelineIssue[],
			}],
		);
		const result = await readCommittedScheduleGuide(repository, 'UTC', '2026-08-26', 1);
		const warning = result.guide.channels[0]?.preview.issues[0];
		expect(warning).toMatchObject({ occurrenceCount: 24, scheduleLayerId: issue.scheduleLayerId });
		expect(warning?.occurrences).toHaveLength(24);
		expect(warning?.occurrences?.[0]).toEqual({ start: at(72), finish: at(72.5), boundaryOrigin: 'layer-exit' });
		expect(warning).not.toHaveProperty('occurrenceCounts');
	});

	it('keeps a bounded issue visible when hidden occurrences may overlap the requested range', async () => {
		const configured = schedule();
		const boundedIssue: TimelineIssue = {
			code: 'boundary-start-rejected',
			message: 'A boundary could not be resolved.',
			templateId: configured.defaultTemplateId,
			scheduleLayerId: null,
			slotId: randomUUID(),
			programId: randomUUID(),
			mediaItemId: null,
			occurrences: [{
				start: '2026-08-22T12:00:00Z',
				finish: null,
				boundaryOrigin: 'template',
			}],
			occurrenceCount: 75,
		};
		const repository = repositoryFixture(
			[configured],
			[segment(configured.channelId)],
			[{
				channelId: configured.channelId,
				health: 'ready',
				committedAt: '2026-08-23T00:01:00Z',
				issues: [boundedIssue],
			}],
		);

		const result = await readCommittedScheduleGuide(repository, 'UTC', START_DATE, 1);

		expect(result.guide.channels[0]?.preview.issues).toEqual([{
			...boundedIssue,
			occurrences: [],
			occurrenceCount: 74,
		}]);
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
