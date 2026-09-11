import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	SECONDS_PER_SCHEDULING_DAY,
	XMLTV_EPG_DAYS,
	type ChannelSchedule,
	type ScheduleTemplate,
	type SchedulingCatalog,
	type SchedulingProgram,
	type SelectionStateRecord,
	type TimelineIssue,
} from '@moirai/shared';
import type {
	MaterializedSegmentRecord,
	Repository,
	TimelineCommit,
	TimelineMaterializationRecord,
} from '@server/repository/index.js';
import { indexSchedulingCatalog } from '@server/scheduling/catalog.js';
import { generateTimelineDetailed } from '@server/scheduling/engine.js';
import { SchedulingWorkerPool } from '@server/scheduling/worker-pool.js';
import { timelineIssuesInRange } from '@server/scheduling/timeline-issues.js';
import {
	mergeTimelineIssues,
	TimelineMaterializer,
} from '@server/scheduling/timeline-materializer.js';

function fixture() {
	const channelId = randomUUID();
	const programId = randomUUID();
	const templateId = randomUUID();
	const slotId = randomUUID();
	const libraryId = randomUUID();
	const schedule: ChannelSchedule = {
		channelId,
		defaultTemplateId: templateId,
		layers: [],
		defaultFiller: null,
		createdAt: '2026-08-01T00:00:00Z',
		updatedAt: '2026-08-01T00:00:00Z',
	};
	const template: ScheduleTemplate = {
		id: templateId,
		name: 'Daily',
		period: 'day',
		defaultFiller: null,
		slots: [
			{
				id: slotId,
				startSeconds: 0,
				programId,
				stateScope: 'persistent',
				startEligibility: { type: 'require-fit' },
				filler: { mode: 'inherit' },
			},
		],
		boundaries: [
			{
				id: randomUUID(),
				leftSlotId: slotId,
				rightSlotId: slotId,
				targetSeconds: SECONDS_PER_SCHEDULING_DAY,
				policy: 'hard',
				maxDriftSeconds: 0,
				fallback: 'reject-start',
				earlyStartMaxDriftSeconds: 0,
			},
		],
		createdAt: '2026-08-01T00:00:00Z',
		updatedAt: '2026-08-01T00:00:00Z',
	};
	const program: SchedulingProgram = {
		id: programId,
		name: 'Five films',
		config: {
			type: 'content',
			source: { type: 'library-query', libraryId, kinds: ['movie'], genres: [] },
			strategy: { type: 'sequential' },
		},
		createdAt: '2026-08-01T00:00:00Z',
		updatedAt: '2026-08-01T00:00:00Z',
	};
	const catalog: SchedulingCatalog = indexSchedulingCatalog({
		media: Array.from({ length: 5 }, (_, index) => ({
			id: randomUUID(),
			libraryId,
			groupId: null,
			kind: 'movie',
			title: `Film ${index + 1}`,
			sortTitle: `film ${index + 1}`,
			playbackPath: `/media/${index + 1}.mkv`,
			durationSeconds: 3600,
			seasonNumber: null,
			episodeNumber: null,
			genres: [],
			genreNames: [],
			plot: null,
			year: 2026,
			artworkUrl: null,
			availability: 'available' as const,
		})),
		groupParents: {},
		groupTitles: {},
		libraryNames: { [libraryId]: 'Movies' },
		libraryAvailability: { [libraryId]: 'available' },
		libraryEnabled: { [libraryId]: true },
	});
	const programs = [program];
	let materialization: TimelineMaterializationRecord | null = null;
	let segments: MaterializedSegmentRecord[] = [];
	let state: SelectionStateRecord[] = [];
	const repository = {
		listChannelSchedules: vi.fn(async () => [schedule]),
		listScheduleTemplates: vi.fn(async () => [template]),
		listPrograms: vi.fn(async () => programs),
		getPlaybackSettings: vi.fn(async () => ({
			maxActiveSessions: 4,
			viewingPreferencesEnabled: true,
		})),
		viewingPreferenceScores: vi.fn(() => ({ itemScores: {}, showScores: {} })),
		getSchedulingCatalog: vi.fn(async () => catalog),
		getTimelineMaterialization: vi.fn(async () => materialization),
		listMaterializedTimelineSegments: vi.fn(
			async (start: string, finish: string, requestedChannel?: string) =>
				segments.filter(
					(entry) =>
						(!requestedChannel || entry.segment.channelId === requestedChannel)
						&& entry.segment.finish > start
						&& entry.segment.start < finish,
				),
		),
		getSelectionState: vi.fn(async () => state),
		markTimelinePending: vi.fn((channelIds: string[], applyAfter: string, pendingSince: string) => {
			if (materialization && channelIds.includes(materialization.channelId)) {
				materialization = {
					...materialization,
					health: 'pending',
					applyAfter,
					pendingSince,
					lastError: null,
				};
			}
		}),
		markTimelineFailed: vi.fn(),
		commitMaterializedTimeline: vi.fn((commit: TimelineCommit) => {
			segments = [
				...segments.filter(
					(entry) =>
						entry.segment.channelId !== commit.channelId
						|| (entry.segment.finish <= commit.replaceFrom
							&& entry.segment.finish > commit.windowStart),
				),
				...commit.segments,
			];
			state = structuredClone(commit.finalState);
			materialization = {
				channelId: commit.channelId,
				health: 'ready',
				windowStart: commit.windowStart,
				windowEnd: commit.windowEnd,
				continuationAt: commit.continuationAt,
				inputFingerprint: commit.inputFingerprint,
				baseState: structuredClone(commit.baseState),
				issues: commit.issues,
				committedAt: commit.committedAt,
				pendingSince: null,
				applyAfter: null,
				lastError: null,
			};
		}),
	} as unknown as Repository;
	return {
		template,
		programs,
		schedule,
		channelId,
		libraryId,
		catalog,
		repository,
		events: { publish: vi.fn() },
		segments: () => segments,
		materialization: () => materialization,
		truncateCommittedTail: (at: string) => {
			segments = segments.filter((entry) => entry.segment.finish <= at);
			materialization!.continuationAt = at;
		},
		setSourceAvailable: (available: boolean) => {
			catalog.libraryAvailability[libraryId] = available ? 'available' : 'unavailable';
			for (const media of catalog.media) {
				media.availability = available ? 'available' : 'unconfirmed';
			}
		},
		setLibraryEnabled: (enabled: boolean) => {
			catalog.libraryEnabled![libraryId] = enabled;
			catalog.libraryAvailability[libraryId] = enabled ? 'available' : 'unavailable';
		},
		failCommittedTimeline: () => {
			if (materialization) {
				materialization.health = 'failed';
				materialization.lastError = 'Scheduled media requires technical inspection before playback';
			}
		},
		changeStrategy: () => {
			program.config = {
				type: 'content',
				source: program.config.type === 'content' ? program.config.source : {
					type: 'library-query',
					libraryId,
					kinds: ['movie'],
					genres: [],
				},
				strategy: { type: 'random', seed: 'changed' },
			};
			program.updatedAt = '2026-08-22T12:15:00Z';
		},
		removeFirstMedia: () => catalog.media.shift()!.id,
		clearFirstDuration: () => {
			catalog.media[0]!.durationSeconds = null;
		},
		restoreFirstDuration: () => {
			catalog.media[0]!.durationSeconds = 3600;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('durable timeline materializer', () => {
	it('retains displacement beyond the original window through a restart and roll', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		const long = test.programs[0]!;
		long.config = { type: 'content', source: { type: 'item', itemId: test.catalog.media[0]!.id }, strategy: { type: 'sequential' } };
		test.catalog.media[0]!.durationSeconds = 29 * 3600;
		const short: SchedulingProgram = {
			...long, id: randomUUID(),
			config: { type: 'content', source: { type: 'item', itemId: test.catalog.media[1]!.id }, strategy: { type: 'sequential' } },
		};
		test.programs.push(short);
		const longSlot = test.template.slots[0]!;
		longSlot.startSeconds = 3600;
		longSlot.startEligibility = { type: 'allow-overrun' };
		const shortSlot = { ...longSlot, id: randomUUID(), startSeconds: 0, programId: short.id };
		test.template.slots = [shortSlot, longSlot];
		const boundary = test.template.boundaries[0]!;
		test.template.boundaries = [
			{ ...boundary, id: randomUUID(), leftSlotId: shortSlot.id, rightSlotId: longSlot.id, targetSeconds: 3600 },
			{ ...boundary, rightSlotId: shortSlot.id, policy: 'finish-left', maxDriftSeconds: null },
		];
		await new TimelineMaterializer(test.repository, test.events, 'UTC').runNow();
		const first = structuredClone(test.materialization()!);
		const deferred = timelineIssuesInRange(first.issues, first.windowEnd, first.continuationAt);
		expect(deferred.some((issue) => issue.code === 'slot-displaced')).toBe(true);

		vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
		await new TimelineMaterializer(test.repository, test.events, 'UTC').runNow();
		const rolled = test.materialization()!;
		expect(timelineIssuesInRange(rolled.issues, first.windowEnd, first.continuationAt)).toEqual(deferred);
		const whole = generateTimelineDetailed({
			channelId: test.channelId, startDate: '2026-08-22', days: XMLTV_EPG_DAYS + 1, timeZone: 'UTC',
			schedule: test.schedule, template: test.template, programs: test.programs, catalog: test.catalog, state: [],
		});
		expect(timelineIssuesInRange(rolled.issues, rolled.windowStart, rolled.continuationAt))
			.toEqual(timelineIssuesInRange(whole.issues, rolled.windowStart, rolled.continuationAt));
	});

	it('repairs an older commit with a short continuation instead of trusting its advertised window', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		await new TimelineMaterializer(test.repository, test.events, 'UTC').runNow();
		const original = test.segments().map((entry) => entry.segment);
		test.truncateCommittedTail(original.at(-1)!.start);
		await new TimelineMaterializer(test.repository, test.events, 'UTC').runNow();
		expect(test.segments().map((entry) => entry.segment)).toEqual(original);
		expect(test.materialization()?.continuationAt).toBe(test.materialization()?.windowEnd);
	});

	it('commits full early-midnight windows and resumes an incoming occurrence across daily rolls', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		const outgoing = test.programs[0]!;
		outgoing.config = { type: 'content', source: { type: 'item', itemId: test.catalog.media[0]!.id }, strategy: { type: 'sequential' } };
		test.catalog.media[0]!.durationSeconds = 22 * 3600;
		const incoming: SchedulingProgram = {
			...outgoing, id: randomUUID(),
			config: {
				type: 'content',
				source: { type: 'collection', libraryId: test.libraryId, itemIds: test.catalog.media.slice(1, 3).map((item) => item.id), sort: { type: 'date-added', direction: 'asc' } },
				strategy: { type: 'sequential' },
			},
		};
		test.programs.push(incoming);
		const outgoingSlot = test.template.slots[0]!;
		outgoingSlot.startSeconds = 3600;
		outgoingSlot.startEligibility = { type: 'allow-overrun' };
		const incomingSlot = { ...outgoingSlot, id: randomUUID(), startSeconds: 0, programId: incoming.id, stateScope: 'occurrence' as const };
		test.template.slots = [incomingSlot, outgoingSlot];
		const boundary = test.template.boundaries[0]!;
		test.template.boundaries = [
			{ ...boundary, id: randomUUID(), leftSlotId: incomingSlot.id, rightSlotId: outgoingSlot.id, targetSeconds: 3600 },
			{ ...boundary, rightSlotId: incomingSlot.id, policy: 'finish-left', fallback: 'favor-right', earlyStartMaxDriftSeconds: 3600 },
		];
		const materializer = new TimelineMaterializer(test.repository, test.events, 'UTC');
		await materializer.runNow();
		expect(test.repository.markTimelineFailed).not.toHaveBeenCalled();
		expect(test.materialization()?.continuationAt).toBe(test.materialization()?.windowEnd);
		expect(test.segments().at(-1)?.segment.finish).toBe(test.materialization()?.windowEnd);

		// A restart and two rolls must preserve an occurrence that started early the preceding day.
		for (const day of [23, 24]) {
			vi.setSystemTime(new Date(`2026-08-${day}T12:00:00Z`));
			await new TimelineMaterializer(test.repository, test.events, 'UTC').runNow();
		}
		const uninterrupted = generateTimelineDetailed({
			channelId: test.channelId, startDate: '2026-08-22', days: XMLTV_EPG_DAYS + 2, timeZone: 'UTC',
			schedule: test.schedule, template: test.template, programs: test.programs, catalog: test.catalog, state: [],
		});
		const retained = uninterrupted.segments.filter((segment) => segment.finish > test.materialization()!.windowStart);
		expect(test.segments().map((entry) => entry.segment)).toEqual(retained);
		expect(test.materialization()?.continuationAt).toBe(uninterrupted.continuationAt);
	});

	it('restores an early favor-right handoff from committed segments after restart', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		const outgoing = test.programs[0]!;
		outgoing.config = { type: 'content', source: { type: 'item', itemId: test.catalog.media[0]!.id }, strategy: { type: 'sequential' } };
		test.catalog.media[0]!.durationSeconds = 23 * 3600;
		test.catalog.media[1]!.durationSeconds = 40 * 60;
		test.catalog.media[2]!.durationSeconds = 2 * 3600;
		const incoming: SchedulingProgram = {
			...outgoing, id: randomUUID(), config: {
				type: 'content', strategy: { type: 'sequential' },
				source: { type: 'collection', libraryId: test.libraryId, itemIds: test.catalog.media.slice(1, 3).map((item) => item.id), sort: { type: 'date-added', direction: 'asc' } },
			},
		};
		test.programs.push(incoming);
		const outgoingSlot = test.template.slots[0]!;
		outgoingSlot.startSeconds = 3600;
		const incomingSlot = { ...outgoingSlot, id: randomUUID(), startSeconds: 0, programId: incoming.id, stateScope: 'occurrence' as const };
		test.template.slots = [incomingSlot, outgoingSlot];
		const boundary = test.template.boundaries[0]!;
		test.template.boundaries = [
			{ ...boundary, id: randomUUID(), leftSlotId: incomingSlot.id, rightSlotId: outgoingSlot.id, targetSeconds: 3600, policy: 'favor-right', maxDriftSeconds: 40 * 60 },
			{ ...boundary, rightSlotId: incomingSlot.id, policy: 'finish-left', fallback: 'favor-right', earlyStartMaxDriftSeconds: 40 * 60 },
		];
		await new TimelineMaterializer(test.repository, test.events, 'UTC').runNow();
		const uninterrupted = structuredClone(test.segments());
		test.truncateCommittedTail('2026-08-23T00:20:00Z');
		expect(test.segments().at(-1)?.continuation).toMatchObject({ date: '2026-08-23', phase: 'primary', hadPrimary: true });
		await new TimelineMaterializer(test.repository, test.events, 'UTC').runNow();
		expect(test.repository.markTimelineFailed).not.toHaveBeenCalled();
		expect(test.segments().map((entry) => entry.segment)).toEqual(uninterrupted.map((entry) => entry.segment));
		expect(test.segments().find((entry) => entry.segment.start === '2026-08-23T00:20:00Z')?.segment.programId).toBe(outgoing.id);
	});

	it('merges retained and regenerated issue occurrences inside the committed window', () => {
		const issue = (occurrences: NonNullable<TimelineIssue['occurrences']>): TimelineIssue => ({
			code: 'boundary-start-rejected',
			message: 'An outgoing item could not finish in time.',
			templateId: 'template',
			scheduleLayerId: 'layer',
			slotId: 'slot',
			programId: 'program',
			mediaItemId: null,
			occurrences,
			occurrenceCount: occurrences.length,
		});
		const merged = mergeTimelineIssues(
			[issue([
				{
					start: '2026-08-22T08:00:00Z',
					finish: '2026-08-22T08:05:00Z',
					boundaryOrigin: 'layer-entry',
				},
				{
					start: '2026-08-22T10:00:00Z',
					finish: '2026-08-22T10:05:00Z',
					boundaryOrigin: 'layer-entry',
				},
			])],
			[issue([
				{
					start: '2026-08-22T10:00:00Z',
					finish: '2026-08-22T10:05:00Z',
					boundaryOrigin: 'layer-entry',
				},
				{
					start: '2026-08-22T12:00:00Z',
					finish: '2026-08-22T12:05:00Z',
					boundaryOrigin: 'layer-entry',
				},
				{
					start: '2026-08-23T02:00:00Z',
					finish: '2026-08-23T02:05:00Z',
					boundaryOrigin: 'layer-entry',
				},
			])],
			'2026-08-22T07:00:00Z',
			'2026-08-22T11:00:00Z',
			'2026-08-23T00:00:00Z',
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.occurrenceCount).toBe(3);
		expect(merged[0]?.occurrences?.map((occurrence) => occurrence.start)).toEqual([
			'2026-08-22T08:00:00Z',
			'2026-08-22T10:00:00Z',
			'2026-08-22T12:00:00Z',
		]);
	});

	it('preserves uncapped occurrence totals independently from bounded details', () => {
		const issue = (
			start: string,
			occurrenceCount: number,
		): TimelineIssue => ({
			code: 'boundary-start-rejected',
			message: 'An outgoing item could not finish in time.',
			templateId: 'template',
			scheduleLayerId: 'layer',
			slotId: 'slot',
			programId: 'program',
			mediaItemId: null,
			occurrences: [{ start, finish: null, boundaryOrigin: 'layer-entry' }],
			occurrenceCount,
		});

		const merged = mergeTimelineIssues(
			[issue('2026-08-22T08:00:00Z', 75)],
			[issue('2026-08-22T12:00:00Z', 25)],
			'2026-08-22T07:00:00Z',
			'2026-08-22T11:00:00Z',
			'2026-08-23T00:00:00Z',
		);

		expect(merged[0]?.occurrenceCount).toBe(100);
		expect(merged[0]?.occurrences).toHaveLength(2);
	});

	it('keeps legacy issues through partial regeneration until the full window is replaced', () => {
		const legacyIssue: TimelineIssue = {
			code: 'source-unavailable',
			message: 'A source was unavailable.',
			templateId: 'template',
			scheduleLayerId: null,
			slotId: 'slot',
			programId: 'program',
			mediaItemId: null,
		};

		expect(mergeTimelineIssues(
			[legacyIssue],
			[],
			'2026-08-22T07:00:00Z',
			'2026-08-22T11:00:00Z',
			'2026-08-23T00:00:00Z',
		)).toEqual([{
			...legacyIssue,
			occurrences: [],
			occurrenceCount: 1,
			occurrenceCounts: [],
			unlocatedOccurrenceCount: 1,
			unlocatedUntil: '2026-08-22T11:00:00Z',
		}]);
		expect(mergeTimelineIssues(
			[legacyIssue],
			[],
			'2026-08-22T07:00:00Z',
			'2026-08-22T07:00:00Z',
			'2026-08-23T00:00:00Z',
		)).toEqual([]);
	});

	it('commits measured media and retains diagnostics for skipped unprobed items', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		test.clearFirstDuration();
		const materializer = new TimelineMaterializer(
			test.repository,
			test.events,
			'America/Los_Angeles',
		);

		await materializer.runNow();

		expect(test.repository.markTimelineFailed).not.toHaveBeenCalled();
		expect(test.materialization()?.health).toBe('ready');
		expect(test.materialization()?.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'media-duration-missing', mediaItemId: test.catalog.media[0]!.id }),
		]));
		expect(test.segments()).toHaveLength(XMLTV_EPG_DAYS * 24);
		expect(test.segments().every(({ segment }) =>
			segment.role === 'primary' && segment.mediaItemId !== test.catalog.media[0]!.id)).toBe(true);
	});

	it('recovers an unprobed empty timeline after restart and a scan without waiting for midnight', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		for (const media of test.catalog.media) {
			media.durationSeconds = null;
		}
		const materializer = new TimelineMaterializer(
			test.repository,
			test.events,
			'America/Los_Angeles',
		);
		await materializer.runNow();
		expect(test.repository.markTimelineFailed).not.toHaveBeenCalled();
		expect(test.segments().every(({ segment }) => segment.role === 'dead-air')).toBe(true);
		expect(test.segments().every((record) => record.stateDelta.length === 0)).toBe(true);
		const restarted = new TimelineMaterializer(test.repository, test.events, 'America/Los_Angeles');
		await restarted.runNow();
		expect(test.repository.commitMaterializedTimeline).toHaveBeenCalledOnce();
		test.repository.markTimelinePending([test.channelId], '2026-08-23T07:00:00Z', '2026-08-22T12:00:00Z');
		test.restoreFirstDuration();

		restarted.handleEvent({
			protocolVersion: 1,
			eventId: randomUUID(),
			occurredAt: new Date().toISOString(),
			type: 'scan.changed',
			data: {
				libraryId: test.libraryId,
				scanId: randomUUID(),
				trigger: 'manual',
				status: 'complete',
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				discoveredCount: test.catalog.media.length,
				changedCount: 1,
				removedCount: 0,
				issueCount: 0,
				affectsProgramming: true,
			},
		});

		await vi.waitFor(() => {
			expect(test.repository.commitMaterializedTimeline).toHaveBeenCalledTimes(2);
		});
		expect(test.materialization()?.health).toBe('ready');
		const primary = test.segments().filter(({ segment }) => segment.role === 'primary');
		expect(primary.length).toBeGreaterThan(24);
		expect(Date.parse(primary[0]!.segment.start) - Date.now()).toBeLessThanOrEqual(1_000);
		expect(primary.every(({ segment }) => segment.mediaItemId === test.catalog.media[0]!.id)).toBe(true);
		expect(test.segments()[0]?.segment).toMatchObject({
			role: 'dead-air', start: '2026-08-22T07:00:00Z', finish: primary[0]!.segment.start,
		});
		for (let index = 1; index < test.segments().length; index += 1) {
			expect(test.segments()[index]!.segment.start).toBe(test.segments()[index - 1]!.segment.finish);
		}
		await restarted.runNow(true);
		expect(test.repository.commitMaterializedTimeline).toHaveBeenCalledTimes(2);
		expect(test.events.publish).toHaveBeenCalledWith({
			type: 'timeline.changed',
			data: { channelId: test.channelId, status: 'ready' },
		});
	});

	it('keeps authored changes pending while recovering catalog-caused dead air', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		for (const media of test.catalog.media) {
			media.durationSeconds = null;
		}
		const materializer = new TimelineMaterializer(test.repository, test.events, 'America/Los_Angeles');
		await materializer.runNow();
		test.changeStrategy();
		test.restoreFirstDuration();
		vi.setSystemTime(new Date('2026-08-22T12:30:00Z'));
		await materializer.runNow(true);

		expect(test.materialization()?.health).toBe('pending');
		expect(test.materialization()?.applyAfter).toBe('2026-08-23T07:00:00Z');
		expect(test.repository.commitMaterializedTimeline).toHaveBeenCalledOnce();
	});

	it('isolates live and committed catalog availability when reusing a worker', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		test.setSourceAvailable(false);
		test.catalog.cacheKey = 'outage-catalog';
		const workers = new SchedulingWorkerPool(1, 4);
		const previewInput = {
			channelId: test.channelId,
			timeZone: 'America/Los_Angeles',
			startDate: '2026-08-22',
			days: 1,
			schedule: test.schedule,
			template: test.template,
			programs: test.programs,
			catalog: test.catalog,
			state: [],
		};
		try {
			const before = await workers.generate(previewInput);
			expect(before.segments.every((segment) => segment.role === 'dead-air')).toBe(true);
			const materializer = new TimelineMaterializer(test.repository, test.events, 'America/Los_Angeles', workers);
			await materializer.runNow();
			expect(test.repository.markTimelineFailed).not.toHaveBeenCalled();
			expect(test.segments()).toHaveLength(XMLTV_EPG_DAYS * 24);
			expect(test.segments().every(({ segment }) => segment.role === 'primary')).toBe(true);
			expect(test.materialization()?.issues.some((issue) => issue.code === 'source-unavailable')).toBe(false);

			const after = await workers.generate(previewInput);
			expect(after.segments).toEqual(before.segments);
			expect(after.issues).toEqual(before.issues);

			// An explicit disable remains authoritative even though outage flags are normalized.
			test.setLibraryEnabled(false);
			test.catalog.cacheKey = 'disabled-catalog';
			await materializer.applyNow(test.channelId);
			expect(test.segments().filter(({ segment }) => segment.start >= '2026-08-22T12:00:00Z')
				.every(({ segment }) => segment.role === 'dead-air')).toBe(true);
		}
		finally {
			await workers.close();
		}
	});

	it('rechecks a failed committed timeline even when its rolling window is already full', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		const materializer = new TimelineMaterializer(
			test.repository,
			test.events,
			'America/Los_Angeles',
		);
		await materializer.runNow();
		expect(test.repository.commitMaterializedTimeline).toHaveBeenCalledOnce();
		test.failCommittedTimeline();

		materializer.handleEvent({
			protocolVersion: 1,
			eventId: randomUUID(),
			occurredAt: new Date().toISOString(),
			type: 'scan.changed',
			data: {
				libraryId: test.libraryId,
				scanId: randomUUID(),
				trigger: 'manual',
				status: 'complete',
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				discoveredCount: test.catalog.media.length,
				changedCount: 0,
				removedCount: 0,
				issueCount: 0,
				affectsProgramming: true,
			},
		});

		await vi.waitFor(() => {
			expect(test.repository.commitMaterializedTimeline).toHaveBeenCalledTimes(2);
		});
		expect(test.materialization()?.health).toBe('ready');
	});

	it('runs a recovery recheck queued during an active materialization without waiting', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		let releaseCatalog!: (catalog: SchedulingCatalog) => void;
		vi.mocked(test.repository.getSchedulingCatalog)
			.mockImplementationOnce(() => new Promise((resolve) => {
				releaseCatalog = resolve;
			}))
			.mockResolvedValue(test.catalog);
		const materializer = new TimelineMaterializer(
			test.repository,
			test.events,
			'America/Los_Angeles',
		);
		const active = materializer.runNow();
		await vi.waitFor(() => {
			expect(test.repository.getSchedulingCatalog).toHaveBeenCalledOnce();
		});

		materializer.handleEvent({
			protocolVersion: 1,
			eventId: randomUUID(),
			occurredAt: new Date().toISOString(),
			type: 'scan.changed',
			data: {
				libraryId: test.libraryId,
				scanId: randomUUID(),
				trigger: 'manual',
				status: 'complete',
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				discoveredCount: test.catalog.media.length,
				changedCount: 1,
				removedCount: 0,
				issueCount: 0,
				affectsProgramming: true,
			},
		});
		releaseCatalog(test.catalog);
		await active;

		await vi.waitFor(() => {
			expect(test.repository.getSchedulingCatalog).toHaveBeenCalledTimes(2);
		});
	});

	it('preserves the overlapping window and continues sequential state after a restart', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		const first = new TimelineMaterializer(
			test.repository,
			test.events,
			'America/Los_Angeles',
		);
		await first.runNow();
		const initial = structuredClone(test.segments());
		const initialEnd = test.materialization()!.windowEnd;
		expect(initial).toHaveLength(XMLTV_EPG_DAYS * 24);

		vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
		const restarted = new TimelineMaterializer(
			test.repository,
			test.events,
			'America/Los_Angeles',
		);
		await restarted.runNow();

		const rolled = test.segments();
		const originalOverlap = initial.filter((entry) => entry.segment.start >= '2026-08-23T07:00:00Z');
		const rolledIds = new Set(rolled.map((entry) => entry.segment.id));
		expect(originalOverlap.every((entry) => rolledIds.has(entry.segment.id))).toBe(true);
		expect(rolled.find((entry) => entry.segment.start === initialEnd)?.segment.title).toBe('Film 2');
	});

	it('extends from retained catalog data during a temporary source outage', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		const materializer = new TimelineMaterializer(
			test.repository,
			test.events,
			'America/Los_Angeles',
		);
		await materializer.runNow();
		const initialEnd = test.materialization()!.windowEnd;
		test.setSourceAvailable(false);
		vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));

		await materializer.runNow();

		expect(test.materialization()!.health).toBe('ready');
		expect(test.segments().some((entry) => entry.segment.start === initialEnd)).toBe(true);
		expect(test.segments().filter((entry) => entry.segment.role === 'dead-air')).toHaveLength(0);
	});

	it('marks disabled-library output pending and excludes it from the replacement window', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		const materializer = new TimelineMaterializer(
			test.repository,
			test.events,
			'America/Los_Angeles',
		);
		await materializer.runNow();
		test.setLibraryEnabled(false);

		await materializer.runNow(true);

		expect(test.materialization()!.health).toBe('pending');
		vi.setSystemTime(new Date('2026-08-23T07:00:01Z'));
		await materializer.runNow(true);
		expect(test.materialization()!.health).toBe('ready');
		expect(
			test
				.segments()
				.filter((entry) => entry.segment.start >= '2026-08-23T07:00:00Z')
				.every((entry) => entry.segment.mediaItemId === null),
		).toBe(true);
	});

	it('applies pending configuration after the current item without replacing it', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:30:00Z'));
		const test = fixture();
		const materializer = new TimelineMaterializer(
			test.repository,
			test.events,
			'America/Los_Angeles',
		);
		await materializer.runNow();
		const active = test
			.segments()
			.find(
				(entry) =>
					entry.segment.start < '2026-08-22T12:30:00Z'
					&& entry.segment.finish > '2026-08-22T12:30:00Z',
			)!;
		test.changeStrategy();
		await materializer.runNow(true);
		expect(test.materialization()!.health).toBe('pending');

		await materializer.applyNow(test.channelId);

		expect(test.materialization()!.health).toBe('ready');
		expect(test.segments().some((entry) => entry.segment.id === active.segment.id)).toBe(true);
		expect(
			test.segments().some((entry) => entry.segment.start === active.segment.finish),
		).toBe(true);
	});

	it('rebuilds unlocked future rows after a healthy catalog deletion', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
		const test = fixture();
		const materializer = new TimelineMaterializer(
			test.repository,
			test.events,
			'America/Los_Angeles',
		);
		await materializer.runNow();
		const removedId = test.removeFirstMedia();
		await materializer.runNow(true);
		expect(test.materialization()!.health).toBe('pending');

		vi.setSystemTime(new Date('2026-08-23T07:00:01Z'));
		await materializer.runNow(true);

		expect(test.materialization()!.health).toBe('ready');
		expect(
			test
				.segments()
				.filter((entry) => entry.segment.start >= '2026-08-23T07:00:00Z')
				.some((entry) => entry.segment.mediaItemId === removedId),
		).toBe(false);
	});
});


it('keeps committed playback and selection state unchanged after a guide-only edit', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
	const test = fixture();
	const materializer = new TimelineMaterializer(test.repository, test.events, 'UTC');
	await materializer.runNow();
	const before = await test.repository.listMaterializedTimelineSegments('2026-08-23T00:00:00Z', '2026-09-06T00:00:00Z');
	const state = await test.repository.getSelectionState(test.channelId);
	test.template.schedulingUpdatedAt = test.template.updatedAt;
	test.template.updatedAt = '2026-08-23T12:01:00Z';
	test.template.slots[0]!.guide = { mode: 'block', title: 'Rock Music', description: '', boundary: 'scheduled' };
	materializer.handleEvent({ protocolVersion: 1, eventId: randomUUID(), occurredAt: '2026-08-23T12:01:00Z',
		type: 'scheduling.changed', data: { entity: 'template', change: 'updated', id: test.template.id } });
	await materializer.runNow();
	expect(test.repository.commitMaterializedTimeline).toHaveBeenCalledOnce();
	expect(test.repository.markTimelinePending).not.toHaveBeenCalled();
	expect(await test.repository.listMaterializedTimelineSegments('2026-08-23T00:00:00Z', '2026-09-06T00:00:00Z')).toEqual(before);
	expect(await test.repository.getSelectionState(test.channelId)).toEqual(state);
});

it('records nominal slots displaced by an overrun without changing realized playback', () => {
	const test = fixture();
	for (const media of test.catalog.media) {
		media.durationSeconds = 7200;
	}
	const initial = test.template.slots[0]!;
	initial.startEligibility = { type: 'allow-overrun' };
	test.template.slots = [initial, { ...initial, id: randomUUID(), startSeconds: 3600 },
		{ ...initial, id: randomUUID(), startSeconds: 7200 }];
	test.template.boundaries = test.template.slots.map((slot, index, slots) => ({
		id: randomUUID(), leftSlotId: slot.id, rightSlotId: slots[(index + 1) % slots.length]!.id,
		targetSeconds: slots[index + 1]?.startSeconds ?? SECONDS_PER_SCHEDULING_DAY,
		policy: 'finish-left', maxDriftSeconds: 7200, fallback: 'favor-right', earlyStartMaxDriftSeconds: 0,
	}));
	const generated = generateTimelineDetailed({
		channelId: test.channelId, schedule: test.schedule, template: test.template,
		programs: test.programs, catalog: test.catalog, state: [], timeZone: 'UTC', startDate: '2026-08-23', days: 1,
	});
	expect(generated.guideOccurrences[0]).toMatchObject({
		start: '2026-08-23T00:00:00Z', finish: '2026-08-23T01:00:00Z',
		actualStart: '2026-08-23T00:00:00Z', actualFinish: '2026-08-23T02:00:00Z',
	});
	expect(generated.guideOccurrences[1]).toMatchObject({
		start: '2026-08-23T01:00:00Z', finish: '2026-08-23T02:00:00Z', actualStart: null, actualFinish: null,
	});
	expect(generated.segments[0]?.finish).toBe('2026-08-23T02:00:00Z');
});
