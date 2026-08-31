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

	it('uses the configured local-day boundaries and leaves unscheduled time for worker filler', () => {
		const configured = channel();
		const guide: ScheduleGuide = {
			timeZone: 'America/Los_Angeles',
			startDate: '2026-11-01',
			requestedDays: 1,
			days: 1,
			segmentLimitApplied: false,
			channels: [],
		};

		const files = buildEtvPlayoutFiles([configured], guide);
		const [filePath, content] = [...files][0]!;
		const document = JSON.parse(content);

		expect(filePath).toContain(
			'20261101T000000.000000000-0700_20261102T000000.000000000-0800.json',
		);
		expect(document.items).toEqual([]);
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
