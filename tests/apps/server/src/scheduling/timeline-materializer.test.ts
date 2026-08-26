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
} from '@moirai/shared';
import type {
	MaterializedSegmentRecord,
	Repository,
	TimelineCommit,
	TimelineMaterializationRecord,
} from '@server/repository/index.js';
import { indexSchedulingCatalog } from '@server/scheduling/catalog.js';
import { TimelineMaterializer } from '@server/scheduling/timeline-materializer.js';

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
	let materialization: TimelineMaterializationRecord | null = null;
	let segments: MaterializedSegmentRecord[] = [];
	let state: SelectionStateRecord[] = [];
	const repository = {
		listChannelSchedules: vi.fn(async () => [schedule]),
		listScheduleTemplates: vi.fn(async () => [template]),
		listPrograms: vi.fn(async () => [program]),
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
		channelId,
		libraryId,
		catalog,
		repository,
		events: { publish: vi.fn() },
		segments: () => segments,
		materialization: () => materialization,
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
	it('fails authoritative materialization when referenced media has not been probed', async () => {
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

		expect(test.repository.markTimelineFailed).toHaveBeenCalledWith(
			test.channelId,
			'Scheduled media requires technical inspection before playback',
			expect.any(String),
		);
		expect(test.repository.commitMaterializedTimeline).not.toHaveBeenCalled();
	});

	it('retries a failed dependent timeline immediately after a recovered scan', async () => {
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
		expect(test.repository.markTimelineFailed).toHaveBeenCalledOnce();
		test.restoreFirstDuration();

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

		await vi.waitFor(() => {
			expect(test.repository.commitMaterializedTimeline).toHaveBeenCalledOnce();
		});
		expect(test.events.publish).toHaveBeenCalledWith({
			type: 'timeline.changed',
			data: { channelId: test.channelId, status: 'ready' },
		});
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
