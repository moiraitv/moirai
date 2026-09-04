import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { channelCreateSchema, type Channel, type ScheduleGuide } from '@moirai/shared';
import { buildEtvPlayoutFiles } from '@server/playback/playout-output.js';

/** Build a channel with validated normalization defaults. */
function channel(): Channel {
	return {
		...channelCreateSchema.parse({ number: '100.1', name: 'Test Channel' }),
		id: randomUUID(),
		createdAt: '2026-08-23T00:00:00Z',
		updatedAt: '2026-08-23T00:00:00Z',
	};
}

/** Build one deterministic fallback source for generated playout coverage. */
function fallback(configured: Channel, overrides: {
	durationMilliseconds?: number;
	hasAudio?: boolean;
} = {}) {
	return new Map([[configured.id, {
		path: '/fallback/dead-air.mp4',
		durationMilliseconds: overrides.durationMilliseconds ?? 161_000,
		hasAudio: overrides.hasAudio ?? true,
	}]]);
}

/** Return the fallback source position at one instant in a generated document. */
function sourceOffsetAt(document: { items: Array<{
	start: string;
	finish: string;
	source: { in_point_ms?: number };
}> }, at: string): number {
	const item = document.items.find((candidate) => candidate.start <= at && candidate.finish > at)!;
	return (item.source.in_point_ms ?? 0) + Date.parse(at) - Date.parse(item.start);
}

describe('ErsatzTV playout output', () => {
	it('splits cross-midnight media into non-overlapping daily files with continued offsets', () => {
		const configured = channel();
		const guide: ScheduleGuide = {
			timeZone: 'UTC',
			startDate: '2026-08-23',
			requestedDays: 2,
			days: 2,
			segmentLimitApplied: false,
			channels: [
				{
					channelId: configured.id,
					preview: {
						channelId: configured.id,
						timeZone: 'UTC',
						startDate: '2026-08-23',
						days: 2,
						segments: [
							{
								id: 'cross-midnight',
								role: 'primary',
								channelId: configured.id,
								scheduleLayerId: null,
								templateId: randomUUID(),
								slotId: randomUUID(),
								programId: randomUUID(),
								mediaItemId: randomUUID(),
								title: 'Movie',
								playbackPath: '/media/movie.mkv',
								start: '2026-08-23T23:30:00Z',
								finish: '2026-08-24T00:30:00Z',
								sourceStartSeconds: 60,
								sourceFinishSeconds: 3_660,
								truncated: false,
							},
						],
						issues: [],
						proposedState: [],
					},
				},
			],
		};

		const files = buildEtvPlayoutFiles([configured], guide);
		const documents = [...files.values()].map((content) => JSON.parse(content));

		expect(files).toHaveLength(2);
		expect(documents[0].items[0].source).toMatchObject({
			in_point_ms: 60_000,
			out_point_ms: 1_860_000,
		});
		expect(documents[1].items[0].source).toMatchObject({
			in_point_ms: 1_860_000,
			out_point_ms: 3_660_000,
		});
	});

	it('rounds floating-point clipping artifacts at a local-day boundary', () => {
		const configured = channel();
		const guide: ScheduleGuide = {
			timeZone: 'America/Los_Angeles',
			startDate: '2026-08-26',
			requestedDays: 1,
			days: 1,
			segmentLimitApplied: false,
			channels: [{
				channelId: configured.id,
				preview: {
					channelId: configured.id,
					timeZone: 'America/Los_Angeles',
					startDate: '2026-08-26',
					days: 1,
					segments: [{
						id: 'floating-boundary',
						role: 'primary',
						channelId: configured.id,
						scheduleLayerId: null,
						templateId: randomUUID(),
						slotId: randomUUID(),
						programId: randomUUID(),
						mediaItemId: randomUUID(),
						title: 'Movie',
						playbackPath: '/media/movie.mkv',
						playbackParts: [{
							playbackPath: '/media/movie.mkv',
							durationSeconds: 7_005.047,
						}],
						start: '2026-08-26T05:04:25.223Z',
						finish: '2026-08-26T07:01:10.270Z',
						sourceStartSeconds: 0,
						sourceFinishSeconds: 7_005.047,
						truncated: false,
					}],
					issues: [],
					proposedState: [],
				},
			}],
		};

		const document = JSON.parse([...buildEtvPlayoutFiles([configured], guide).values()][0]!);

		expect(document.items).toHaveLength(1);
		expect(document.items[0]).toMatchObject({
			start: '2026-08-26T07:00:00Z',
			finish: '2026-08-26T07:01:10.27Z',
			source: {
				in_point_ms: 6_934_777,
				out_point_ms: 7_005_047,
			},
		});
	});

	it('does not emit zero-length multipart fragments at an exact daily boundary', () => {
		const configured = channel();
		const guide: ScheduleGuide = {
			timeZone: 'America/Los_Angeles',
			startDate: '2026-08-25',
			requestedDays: 2,
			days: 2,
			segmentLimitApplied: false,
			channels: [{
				channelId: configured.id,
				preview: {
					channelId: configured.id,
					timeZone: 'America/Los_Angeles',
					startDate: '2026-08-25',
					days: 2,
					segments: [{
						id: 'multipart-boundary',
						role: 'primary',
						channelId: configured.id,
						scheduleLayerId: null,
						templateId: randomUUID(),
						slotId: randomUUID(),
						programId: randomUUID(),
						mediaItemId: randomUUID(),
						title: 'Multipart Movie',
						playbackPath: '/media/movie-cd1.mkv',
						playbackParts: [
							{ playbackPath: '/media/movie-cd1.mkv', durationSeconds: 3_600.001 },
							{ playbackPath: '/media/movie-cd2.mkv', durationSeconds: 3_600.002 },
							{ playbackPath: '/media/movie-cd3.mkv', durationSeconds: 60 },
						],
						start: '2026-08-26T04:59:59.997Z',
						finish: '2026-08-26T07:01:00Z',
						sourceStartSeconds: 0,
						sourceFinishSeconds: 7_260.003,
						truncated: false,
					}],
					issues: [],
					proposedState: [],
				},
			}],
		};

		const documents = [...buildEtvPlayoutFiles([configured], guide).values()]
			.map((content) => JSON.parse(content));
		const items = documents.flatMap((document) => document.items);

		expect(items.every((item) => Date.parse(item.finish) > Date.parse(item.start))).toBe(true);
		expect(documents[1].items).toEqual([{
			id: 'multipart-boundary:2026-08-26:2',
			start: '2026-08-26T07:00:00Z',
			finish: '2026-08-26T07:01:00Z',
			source: {
				source_type: 'local',
				path: '/media/movie-cd3.mkv',
			},
		}]);
	});

	it('uses configured DST boundaries and fills the complete unscheduled local day', () => {
		const configured = channel();
		configured.createdAt = '2026-11-01T07:00:00Z';
		const guide: ScheduleGuide = {
			timeZone: 'America/Los_Angeles',
			startDate: '2026-11-01',
			requestedDays: 2,
			days: 2,
			segmentLimitApplied: false,
			channels: [],
		};

		const files = buildEtvPlayoutFiles([configured], guide, fallback(configured));
		const [filePath, content] = [...files][0]!;
		const document = JSON.parse(content);

		expect(filePath).toContain(
			'20261101T000000.000000000-0700_20261102T000000.000000000-0800.json',
		);
		expect(document.items[0].start).toBe('2026-11-01T07:00:00Z');
		expect(document.items.at(-1).finish).toBe('2026-11-02T08:00:00Z');
		for (let index = 1; index < document.items.length; index += 1) {
			expect(document.items[index].start).toBe(document.items[index - 1].finish);
		}
		const nextDocument = JSON.parse([...files.values()][1]!);
		const priorOutPoint = document.items.at(-1).source.out_point_ms;
		expect(nextDocument.items[0].source.in_point_ms ?? 0).toBe(priorOutPoint % 161_000);
	});

	it('rejects only a playback fallback source shorter than one minute', () => {
		const configured = channel();
		const guide: ScheduleGuide = {
			timeZone: 'UTC',
			startDate: '2026-08-23',
			requestedDays: 1,
			days: 1,
			segmentLimitApplied: false,
			channels: [],
		};

		expect(() => buildEtvPlayoutFiles(
			[configured],
			guide,
			fallback(configured, { durationMilliseconds: 59_999 }),
		)).toThrow('at least 1 minute');
	});

	it('continues to emit authored filler shorter than one minute', () => {
		const configured = channel();
		const guide: ScheduleGuide = {
			timeZone: 'UTC',
			startDate: '2026-08-23',
			requestedDays: 1,
			days: 1,
			segmentLimitApplied: false,
			channels: [{
				channelId: configured.id,
				preview: {
					channelId: configured.id,
					timeZone: 'UTC',
					startDate: '2026-08-23',
					days: 1,
					segments: [{
						id: 'commercial',
						role: 'filler',
						channelId: configured.id,
						scheduleLayerId: null,
						templateId: randomUUID(),
						slotId: randomUUID(),
						programId: randomUUID(),
						mediaItemId: randomUUID(),
						title: 'Commercial',
						playbackPath: '/media/commercial.mp4',
						start: '2026-08-23T12:00:00Z',
						finish: '2026-08-23T12:00:30Z',
						sourceStartSeconds: 0,
						sourceFinishSeconds: 30,
						truncated: false,
					}],
					issues: [],
					proposedState: [],
				},
			}],
		};

		const document = JSON.parse([...buildEtvPlayoutFiles([configured], guide).values()][0]!);
		expect(document.items).toEqual([expect.objectContaining({
			id: 'commercial:2026-08-23',
			start: '2026-08-23T12:00:00Z',
			finish: '2026-08-23T12:00:30Z',
		})]);
	});

	it('truncates a fallback for a short gap and loops it for a longer gap', () => {
		const configured = channel();
		const guide: ScheduleGuide = {
			timeZone: 'UTC',
			startDate: '2026-08-23',
			requestedDays: 1,
			days: 1,
			segmentLimitApplied: false,
			channels: [{
				channelId: configured.id,
				preview: {
					channelId: configured.id,
					timeZone: 'UTC',
					startDate: '2026-08-23',
					days: 1,
					segments: [{
						id: 'scheduled',
						role: 'primary',
						channelId: configured.id,
						scheduleLayerId: null,
						templateId: randomUUID(),
						slotId: randomUUID(),
						programId: randomUUID(),
						mediaItemId: randomUUID(),
						title: 'Scheduled',
						playbackPath: '/media/scheduled.mp4',
						start: '2026-08-23T00:01:30Z',
						finish: '2026-08-23T23:53:20Z',
						sourceStartSeconds: 0,
						sourceFinishSeconds: 85_910,
						truncated: false,
					}],
					issues: [],
					proposedState: [],
				},
			}],
		};

		const document = JSON.parse([
			...buildEtvPlayoutFiles(
				[configured],
				guide,
				fallback(configured, { durationMilliseconds: 161_000 }),
			).values(),
		][0]!);
		const fallbackItems = document.items.filter((item: { source: { path: string } }) =>
			item.source.path === '/fallback/dead-air.mp4');
		const openingItems = fallbackItems.filter((item: { finish: string }) =>
			item.finish <= '2026-08-23T00:01:30Z');
		const closingItems = fallbackItems.filter((item: { start: string }) =>
			item.start >= '2026-08-23T23:53:20Z');

		expect(openingItems[0].start).toBe('2026-08-23T00:00:00Z');
		expect(openingItems.at(-1).finish).toBe('2026-08-23T00:01:30Z');
		expect(openingItems).toHaveLength(1);
		expect(openingItems[0].source).not.toHaveProperty('in_point_ms');
		expect(closingItems[0].start).toBe('2026-08-23T23:53:20Z');
		expect(closingItems.at(-1).finish).toBe('2026-08-24T00:00:00Z');
		expect(closingItems[0].source).not.toHaveProperty('in_point_ms');
		expect(closingItems.some((item: { source: { out_point_ms: number } }) =>
			item.source.out_point_ms === 161_000)).toBe(true);
	});

	it('merges explicit dead air and missing paths into one exact-duration fallback pass', () => {
		const configured = channel();
		const templateId = randomUUID();
		const slotId = randomUUID();
		const guide: ScheduleGuide = {
			timeZone: 'UTC',
			startDate: '2026-08-23',
			requestedDays: 1,
			days: 1,
			segmentLimitApplied: false,
			channels: [{
				channelId: configured.id,
				preview: {
					channelId: configured.id,
					timeZone: 'UTC',
					startDate: '2026-08-23',
					days: 1,
					segments: [
						{
							id: 'missing-path',
							role: 'primary',
							channelId: configured.id,
							scheduleLayerId: null,
							templateId,
							slotId,
							programId: randomUUID(),
							mediaItemId: randomUUID(),
							title: 'Unavailable media',
							playbackPath: null,
							start: '2026-08-23T00:00:00Z',
							finish: '2026-08-23T00:01:00Z',
							sourceStartSeconds: 0,
							sourceFinishSeconds: 60,
							truncated: false,
						},
						{
							id: 'explicit-dead-air',
							role: 'dead-air',
							channelId: configured.id,
							scheduleLayerId: null,
							templateId,
							slotId,
							programId: null,
							mediaItemId: null,
							title: 'Dead air',
							playbackPath: null,
							start: '2026-08-23T00:01:00Z',
							finish: '2026-08-23T00:03:00Z',
							sourceStartSeconds: 0,
							sourceFinishSeconds: null,
							truncated: false,
						},
					],
					issues: [],
					proposedState: [],
				},
			}],
		};
		const document = JSON.parse([...buildEtvPlayoutFiles(
			[configured],
			guide,
			fallback(configured, { durationMilliseconds: 180_000 }),
		).values()][0]!);

		expect(document.items[0]).toMatchObject({
			start: '2026-08-23T00:00:00Z',
			finish: '2026-08-23T00:03:00Z',
			source: { path: '/fallback/dead-air.mp4', out_point_ms: 180_000 },
		});
		expect(document.items[0].source).not.toHaveProperty('in_point_ms');
	});

	it('preserves fallback source phase across daily files and synthesizes optional audio', () => {
		const configured = channel();
		const guide: ScheduleGuide = {
			timeZone: 'UTC',
			startDate: '2026-08-23',
			requestedDays: 2,
			days: 2,
			segmentLimitApplied: false,
			channels: [],
		};
		const documents = [...buildEtvPlayoutFiles(
			[configured],
			guide,
			fallback(configured, { durationMilliseconds: 420_000, hasAudio: false }),
		).values()].map((content) => JSON.parse(content));

		expect(documents[1].items[0]).toMatchObject({
			start: '2026-08-24T00:00:00Z',
			source: { in_point_ms: 360_000, out_point_ms: 420_000 },
			tracks: {
				audio: {
					source: {
						source_type: 'lavfi',
						params: 'anullsrc=channel_layout=stereo:sample_rate=48000',
					},
				},
			},
		});
	});

	it('keeps empty-guide fallback phase stable when the rolling window advances', () => {
		const configured = channel();
		const firstGuide: ScheduleGuide = {
			timeZone: 'UTC',
			startDate: '2026-08-23',
			requestedDays: 2,
			days: 2,
			segmentLimitApplied: false,
			channels: [],
		};
		const advancedGuide: ScheduleGuide = {
			...firstGuide,
			startDate: '2026-08-24',
			requestedDays: 1,
			days: 1,
		};
		const configuredFallback = fallback(configured, { durationMilliseconds: 420_000 });
		const retainedDocument = JSON.parse([...buildEtvPlayoutFiles(
			[configured],
			firstGuide,
			configuredFallback,
		).values()][1]!);
		const advancedDocument = JSON.parse([...buildEtvPlayoutFiles(
			[configured],
			advancedGuide,
			configuredFallback,
		).values()][0]!);

		expect(sourceOffsetAt(advancedDocument, '2026-08-24T00:04:00Z'))
			.toBe(sourceOffsetAt(retainedDocument, '2026-08-24T00:04:00Z'));
	});

	it('keeps fallback source phase stable when the rolling window advances', () => {
		const configured = channel();
		const firstGuide: ScheduleGuide = {
			timeZone: 'UTC',
			startDate: '2026-08-23',
			requestedDays: 2,
			days: 2,
			segmentLimitApplied: false,
			channels: [{
				channelId: configured.id,
				preview: {
					channelId: configured.id,
					timeZone: 'UTC',
					startDate: '2026-08-23',
					days: 2,
					segments: [
						{
							id: 'before-fallback',
							role: 'primary',
							channelId: configured.id,
							scheduleLayerId: null,
							templateId: randomUUID(),
							slotId: randomUUID(),
							programId: randomUUID(),
							mediaItemId: randomUUID(),
							title: 'Late program',
							playbackPath: '/media/late-program.mkv',
							start: '2026-08-23T23:00:00Z',
							finish: '2026-08-23T23:58:00Z',
							sourceStartSeconds: 0,
							sourceFinishSeconds: 3_480,
							truncated: false,
						},
						{
							id: 'continuous-dead-air',
							role: 'dead-air',
							channelId: configured.id,
							scheduleLayerId: null,
							templateId: randomUUID(),
							slotId: randomUUID(),
							programId: null,
							mediaItemId: null,
							title: 'Dead air',
							playbackPath: null,
							start: '2026-08-23T23:58:00Z',
							finish: '2026-08-25T00:00:00Z',
							sourceStartSeconds: 0,
							sourceFinishSeconds: null,
							truncated: false,
						},
					],
					issues: [],
					proposedState: [],
				},
			}],
		};
		const advancedGuide: ScheduleGuide = {
			...firstGuide,
			startDate: '2026-08-24',
			requestedDays: 1,
			days: 1,
		};
		const configuredFallback = fallback(configured, { durationMilliseconds: 420_000 });
		const firstDocuments = [...buildEtvPlayoutFiles(
			[configured],
			firstGuide,
			configuredFallback,
		).values()].map((content) => JSON.parse(content));
		const advancedDocument = JSON.parse([...buildEtvPlayoutFiles(
			[configured],
			advancedGuide,
			configuredFallback,
		).values()][0]!);
		expect(sourceOffsetAt(firstDocuments[0], '2026-08-23T23:58:00Z')).toBe(0);
		expect(sourceOffsetAt(advancedDocument, '2026-08-24T00:04:00Z'))
			.toBe(sourceOffsetAt(firstDocuments[1], '2026-08-24T00:04:00Z'));
	});

	it('plays multipart media sequentially as one logical guide segment', () => {
		const configured = channel();
		const guide: ScheduleGuide = {
			timeZone: 'UTC',
			startDate: '2026-08-23',
			requestedDays: 1,
			days: 1,
			segmentLimitApplied: false,
			channels: [{
				channelId: configured.id,
				preview: {
					channelId: configured.id,
					timeZone: 'UTC',
					startDate: '2026-08-23',
					days: 1,
					segments: [{
						id: 'multipart',
						role: 'primary',
						channelId: configured.id,
						scheduleLayerId: null,
						templateId: randomUUID(),
						slotId: randomUUID(),
						programId: randomUUID(),
						mediaItemId: randomUUID(),
						title: 'Long Film',
						playbackPath: '/media/film-cd1.mkv',
						playbackParts: [
							{ playbackPath: '/media/film-cd1.mkv', durationSeconds: 50 },
							{ playbackPath: '/media/film-cd2.mkv', durationSeconds: 70 },
						],
						start: '2026-08-23T12:00:00Z',
						finish: '2026-08-23T12:02:00Z',
						sourceStartSeconds: 0,
						sourceFinishSeconds: 120,
						truncated: false,
					}],
					issues: [],
					proposedState: [],
				},
			}],
		};

		const document = JSON.parse([...buildEtvPlayoutFiles([configured], guide).values()][0]!);

		expect(document.items).toHaveLength(2);
		expect(document.items.map((item: { source: { path: string } }) => item.source.path)).toEqual([
			'/media/film-cd1.mkv',
			'/media/film-cd2.mkv',
		]);
		expect(document.items.map((item: { start: string; finish: string }) => [
			item.start,
			item.finish,
		])).toEqual([
			['2026-08-23T12:00:00Z', '2026-08-23T12:00:50Z'],
			['2026-08-23T12:00:50Z', '2026-08-23T12:02:00Z'],
		]);
	});
});
