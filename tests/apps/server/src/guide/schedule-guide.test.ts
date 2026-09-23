import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { SECONDS_PER_SCHEDULING_DAY, XMLTV_EPG_DAYS, scheduleTemplateCreateSchema, type ChannelSchedule, type TimelineIssue, type TimelineSegment } from '@moirai/shared';
import type { Repository } from '@server/repository/index.js';
import { recordTimelineIssue, type RecordedTimelineIssue } from '@server/scheduling/timeline-issues.js';
import {
	boundedGuideWindow,
	CommittedGuideUnavailableError,
	invalidateCommittedGuideCache,
	readCommittedChannelScheduleGuide,
	readCommittedGuideAfterMaterializing,
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
		windowStart?: string;
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
		getSchedulingCatalogForItems: vi.fn().mockResolvedValue({
			media: [],
			groupParents: {},
			libraryAvailability: {},
			groupTitles: {},
			libraryNames: {},
		}),
		listPrograms: vi.fn().mockResolvedValue([]),
		listScheduleTemplates: vi.fn().mockResolvedValue([]),
		listTimelineMaterializations: vi.fn().mockResolvedValue(
			statuses.map((status) => ({
				...status,
				windowStart: status.windowStart ?? RANGE_START,
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
	it('includes current source names for committed items without changing their playback data', async () => {
		const channel = schedule();
		const item = { ...segment(channel.channelId), role: 'primary' as const, programId: randomUUID() };
		const repository = repositoryFixture([channel], [item], [{ channelId: channel.channelId, health: 'ready', committedAt: RANGE_START }]);
		vi.mocked(repository.listPrograms).mockResolvedValue([{ id: item.programId, name: 'Rock Collection' }] as Awaited<ReturnType<Repository['listPrograms']>>);
		const result = await readCommittedScheduleGuide(repository, 'UTC', START_DATE, 1);
		expect(result.guide.channels[0]!.preview.programNames).toEqual({ [item.programId]: 'Rock Collection' });
		expect(result.guide.channels[0]!.preview.segments).toEqual([item]);
		expect(repository.listPrograms).toHaveBeenCalledTimes(1);
		expect(result.catalog.media).toEqual([]);
	});

	it('overlays committed snapshots when XMLTV asks for catalog media', async () => {
		const channel = schedule();
		const item = { ...segment(channel.channelId), role: 'primary' as const, mediaItemId: randomUUID() };
		const snapshot = {
			groupId: null,
			seasonNumber: null,
			episodeNumber: null,
			genres: [],
			genreNames: [],
			plot: null,
			year: null,
			id: item.mediaItemId!,
			libraryId: randomUUID(),
			kind: 'episode' as const,
			title: 'Pilot',
			sortTitle: 'Pilot',
			playbackPath: '/media/pilot.mkv',
			durationSeconds: 1800,
			availability: 'available' as const,
			seriesTitle: 'Seinfeld',
			artworkUrl: null,
		};
		const repository = repositoryFixture([channel], [item], [{
			channelId: channel.channelId, health: 'ready', committedAt: RANGE_START,
		}]);
		vi.mocked(repository.listMaterializedTimelineSegmentsForGuide).mockResolvedValue([
			{ segment: item, mediaSnapshot: snapshot, stateDelta: [] },
		]);

		const result = await readCommittedScheduleGuide(repository, 'UTC', START_DATE, 1, {
			includeMediaCatalog: true,
		});
		expect(result.catalog.media).toEqual([snapshot]);
		expect(repository.listMaterializedTimelineSegmentsForGuide).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			expect.any(Number),
			[channel.channelId],
			true,
		);
	});

	it('overlays live fanart onto committed snapshots that predate role URLs', async () => {
		const channel = schedule();
		const item = { ...segment(channel.channelId), role: 'primary' as const, mediaItemId: randomUUID() };
		const snapshot = {
			groupId: null,
			seasonNumber: null,
			episodeNumber: null,
			genres: [],
			genreNames: [],
			plot: null,
			year: null,
			id: item.mediaItemId!,
			libraryId: randomUUID(),
			kind: 'movie' as const,
			title: 'Alien Resurrection',
			sortTitle: 'Alien Resurrection',
			playbackPath: '/media/alien.mkv',
			durationSeconds: 7000,
			availability: 'available' as const,
			artworkUrl: '/api/v1/artwork/items/old?v=poster',
		};
		const repository = repositoryFixture([channel], [item], [{
			channelId: channel.channelId, health: 'ready', committedAt: RANGE_START,
		}]);
		vi.mocked(repository.listMaterializedTimelineSegmentsForGuide).mockResolvedValue([
			{ segment: item, mediaSnapshot: snapshot, stateDelta: [] },
		]);
		vi.mocked(repository.getSchedulingCatalogForItems).mockResolvedValue({
			media: [{
				...snapshot,
				fanartUrl: '/api/v1/artwork/items/live?v=fanart&role=fanart',
				landscapeUrl: '/api/v1/artwork/items/live?v=land&role=landscape',
				posterUrl: '/api/v1/artwork/items/live?v=poster&role=poster',
			}],
			groupParents: {},
			libraryAvailability: {},
			groupTitles: {},
			libraryNames: {},
		});

		invalidateCommittedGuideCache();
		const result = await readCommittedScheduleGuide(repository, 'UTC', START_DATE, 1, {
			includeMediaCatalog: true,
		});
		expect(result.catalog.media[0]).toMatchObject({
			title: 'Alien Resurrection',
			artworkUrl: snapshot.artworkUrl,
			fanartUrl: '/api/v1/artwork/items/live?v=fanart&role=fanart',
			landscapeUrl: '/api/v1/artwork/items/live?v=land&role=landscape',
		});
	});

	it('keeps a still-playing item that started before the requested local day', async () => {
		const channel = schedule();
		const playing = {
			...segment(channel.channelId, '2026-08-22T22:00:00Z', '2026-08-23T02:00:00Z'),
			role: 'primary' as const,
			title: 'Overnight film',
		};
		const rest = segment(channel.channelId, '2026-08-23T02:00:00Z', RANGE_END);
		const repository = repositoryFixture([channel], [playing, rest], [{
			channelId: channel.channelId,
			health: 'ready',
			committedAt: RANGE_START,
			windowStart: '2026-08-22T00:00:00Z',
		}]);

		invalidateCommittedGuideCache();
		const result = await readCommittedScheduleGuide(repository, 'UTC', START_DATE, 1);

		expect(result.guide.channels[0]!.preview.segments).toEqual([playing, rest]);
		expect(result.guide.channels[0]!.preview.segments[0]!.start).toBe(playing.start);
	});

	it('does not recache a guide after invalidation during the segment query', async () => {
		const channel = schedule();
		const first = { ...segment(channel.channelId), title: 'First' };
		const second = { ...segment(channel.channelId), title: 'Second' };
		const repository = repositoryFixture([channel], [first], [{
			channelId: channel.channelId, health: 'ready', committedAt: RANGE_START,
		}]);
		vi.mocked(repository.listMaterializedTimelineSegmentsForGuide)
			.mockImplementationOnce(async () => {
				invalidateCommittedGuideCache();
				return [{ segment: first, mediaSnapshot: null, stateDelta: [] }];
			})
			.mockResolvedValueOnce([{ segment: second, mediaSnapshot: null, stateDelta: [] }]);

		await readCommittedScheduleGuide(repository, 'UTC', START_DATE, 1);
		const result = await readCommittedScheduleGuide(repository, 'UTC', START_DATE, 1);
		expect(result.guide.channels[0]!.preview.segments[0]!.title).toBe('Second');
		expect(repository.listMaterializedTimelineSegmentsForGuide).toHaveBeenCalledTimes(2);
	});

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('resolves blank guide titles from programs only when needed', async () => {
		const configured = schedule();
		const item = segment(configured.channelId);
		const programId = randomUUID();
		const repository = repositoryFixture([configured], [item], [
			{ channelId: configured.channelId, health: 'ready', committedAt: RANGE_START },
		]);
		const template = {
			...scheduleTemplateCreateSchema.parse({ name: 'Music', slots: [{
				id: item.slotId, startSeconds: 0, programId,
				guide: { mode: 'block', title: '' },
			}], boundaries: [{ id: randomUUID(), leftSlotId: item.slotId, rightSlotId: item.slotId,
				targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard' }] }),
			id: configured.defaultTemplateId, createdAt: RANGE_START, updatedAt: RANGE_START,
		};
		vi.mocked(repository.listScheduleTemplates).mockResolvedValue([template]);
		vi.mocked(repository.listPrograms).mockResolvedValue([{ id: programId, name: 'Music Videos' }] as Awaited<ReturnType<Repository['listPrograms']>>);
		const statuses = await repository.listTimelineMaterializations();
		statuses[0]!.guideOccurrences = [{
			id: 'music', templateId: template.id, slotId: item.slotId!, scheduleLayerId: null, programId,
			start: RANGE_START, finish: RANGE_END, actualStart: RANGE_START, actualFinish: RANGE_END,
		}];
		vi.mocked(repository.listTimelineMaterializations).mockResolvedValue(statuses);

		const result = await readCommittedScheduleGuide(repository, 'UTC', START_DATE, 1);
		expect(result.guide.channels[0]?.entries).toMatchObject([{ kind: 'block', title: 'Music Videos' }]);
		expect(repository.listPrograms).toHaveBeenCalledTimes(1);
		template.slots[0]!.guide = { mode: 'block', title: 'Rock Music', description: '', boundary: 'scheduled' };
		const overridden = await readCommittedScheduleGuide(repository, 'UTC', START_DATE, 1);
		expect(overridden.guide.channels[0]?.entries).toMatchObject([{ kind: 'block', title: 'Rock Music' }]);
		expect(repository.listPrograms).toHaveBeenCalledTimes(1);
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

	it('accepts a lookahead commit that still covers the advertised window after midnight', async () => {
		vi.setSystemTime(new Date('2026-08-23T00:00:01Z'));
		const configured = schedule();
		const advertisedEnd = Temporal.PlainDate.from(START_DATE).add({ days: XMLTV_EPG_DAYS }).toZonedDateTime('UTC').toInstant().toString();
		const covering = segment(configured.channelId, '2026-08-22T00:00:00Z', advertisedEnd);
		const repository = {
			getChannelSchedule: vi.fn().mockResolvedValue(configured),
			getTimelineMaterialization: vi.fn().mockResolvedValue({
				channelId: configured.channelId,
				health: 'ready',
				windowStart: '2026-08-22T00:00:00Z',
				windowEnd: advertisedEnd,
				continuationAt: advertisedEnd,
				committedAt: '2026-08-22T12:00:00Z',
				issues: [],
			}),
			listMaterializedTimelineSegments: vi.fn().mockResolvedValue([
				{ segment: covering, mediaSnapshot: null, stateDelta: [] },
			]),
		} as unknown as Repository;

		await expect(readCommittedChannelScheduleGuide(
			repository,
			'UTC',
			configured.channelId,
			'2026-08-23',
			XMLTV_EPG_DAYS,
		)).resolves.toMatchObject({
			startDate: '2026-08-23',
			days: XMLTV_EPG_DAYS,
			channels: [{ channelId: configured.channelId }],
		});
	});
});

describe('readCommittedGuideAfterMaterializing', () => {
	it('returns committed coverage without materializing when the window is complete', async () => {
		const ensureMaterialized = vi.fn(async () => undefined);
		const guide = { startDate: START_DATE };

		await expect(readCommittedGuideAfterMaterializing(async () => guide, ensureMaterialized))
			.resolves.toBe(guide);
		expect(ensureMaterialized).not.toHaveBeenCalled();
	});

	it('materializes once and retries when committed coverage is initially unavailable', async () => {
		const ensureMaterialized = vi.fn(async () => undefined);
		const guide = { startDate: START_DATE };
		const read = vi.fn()
			.mockRejectedValueOnce(new CommittedGuideUnavailableError(1))
			.mockResolvedValueOnce(guide);

		await expect(readCommittedGuideAfterMaterializing(read, ensureMaterialized)).resolves.toBe(guide);
		expect(ensureMaterialized).toHaveBeenCalledOnce();
		expect(read).toHaveBeenCalledTimes(2);
	});
});
