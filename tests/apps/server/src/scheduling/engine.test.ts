import { describe, expect, it } from 'vitest';
import type {
	ChannelSchedule,
	ProgramConfig,
	ScheduleBoundary,
	ScheduleSlot,
	ScheduleTemplate,
	SchedulableMedia,
	SchedulingProgram,
	SelectionStateRecord,
} from '@moirai/shared';
import {
	MAX_MEDIA_DURATION_MILLISECONDS,
	MAX_TIMELINE_SEGMENTS,
	SECONDS_PER_SCHEDULING_DAY,
} from '@moirai/shared';
import {
	generateTimeline,
	TimelineMaterializationLimitError,
	type GenerateTimelineInput,
} from '@server/scheduling/engine.js';

const uuid = (value: number): string =>
	`00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

function media(
	value: number,
	durationSeconds: number | null,
	options: Partial<SchedulableMedia> = {},
): SchedulableMedia {
	return {
		id: uuid(value),
		libraryId: uuid(900),
		groupId: null,
		kind: 'movie',
		title: `Item ${value}`,
		sortTitle: `Item ${value.toString().padStart(3, '0')}`,
		playbackPath: `/media/${value}.mkv`,
		durationSeconds,
		seasonNumber: null,
		episodeNumber: null,
		genres: [],
		genreNames: [],
		plot: null,
		year: null,
		artworkUrl: null,
		availability: 'available',
		...options,
	};
}

function program(value: number, config: ProgramConfig): SchedulingProgram {
	return {
		id: uuid(value),
		name: `Program ${value}`,
		config,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};
}

function contentProgram(
	value: number,
	itemIds: number[] | number,
	strategy: 'sequential' | 'shuffle' | 'random' = 'sequential',
): SchedulingProgram {
	const ids = Array.isArray(itemIds) ? itemIds : [itemIds];
	return program(value, {
		type: 'content',
		source:
      ids.length === 1
      	? { type: 'item', itemId: uuid(ids[0]!) }
      	: { type: 'library-query', libraryId: uuid(900), kinds: [], genres: [] },
		strategy: strategy === 'sequential' ? { type: strategy } : { type: strategy, seed: 'fixture' },
	});
}

interface SlotFixture {
	programId: string | null;
	startSeconds: number;
	startEligibility?: ScheduleSlot['startEligibility'];
	filler?: ScheduleSlot['filler'];
	boundary?: Partial<Omit<ScheduleBoundary, 'id' | 'leftSlotId' | 'rightSlotId' | 'targetSeconds'>>;
}

function template(
	slotFixtures: SlotFixture[],
	defaultFiller: ScheduleTemplate['defaultFiller'] = null,
	idValue = 100,
) {
	const slots: ScheduleSlot[] = slotFixtures.map((fixture, index) => ({
		id: uuid(200 + index),
		startSeconds: fixture.startSeconds,
		programId: fixture.programId,
		stateScope: 'persistent',
		startEligibility: fixture.startEligibility ?? { type: 'require-fit' },
		filler: fixture.filler ?? { mode: 'inherit' },
	}));
	const boundaries: ScheduleBoundary[] = slots.map((slot, index) => ({
		id: uuid(300 + index),
		leftSlotId: slot.id,
		rightSlotId: slots[(index + 1) % slots.length]!.id,
		targetSeconds:
      index === slots.length - 1 ? SECONDS_PER_SCHEDULING_DAY : slots[index + 1]!.startSeconds,
		policy: slotFixtures[index]!.boundary?.policy ?? 'hard',
		maxDriftSeconds:
      slotFixtures[index]!.boundary?.maxDriftSeconds === undefined
      	? 0
      	: slotFixtures[index]!.boundary!.maxDriftSeconds,
		fallback: slotFixtures[index]!.boundary?.fallback ?? 'reject-start',
	}));
	const result: ScheduleTemplate = {
		id: uuid(idValue),
		name: 'Daily',
		period: 'day',
		defaultFiller,
		slots,
		boundaries,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};
	return result;
}

function input(
	programs: SchedulingProgram[],
	catalogMedia: SchedulableMedia[],
	dailyTemplate: ScheduleTemplate,
	options: Partial<GenerateTimelineInput> = {},
): GenerateTimelineInput {
	const schedule: ChannelSchedule = {
		channelId: uuid(50),
		defaultTemplateId: dailyTemplate.id,
		layers: [],
		defaultFiller: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};
	return {
		channelId: schedule.channelId,
		timeZone: 'UTC',
		startDate: '2026-01-05',
		days: 1,
		schedule,
		template: dailyTemplate,
		programs,
		catalog: {
			media: catalogMedia,
			groupParents: {},
			libraryAvailability: { [uuid(900)]: 'available' },
			groupTitles: {},
			libraryNames: { [uuid(900)]: 'Library' },
		},
		state: [],
		...options,
	};
}

function primaryTitles(result: ReturnType<typeof generateTimeline>, slotIndex = 0): string[] {
	const slotId = result.segments.find((segment) => segment.role === 'primary')?.slotId;
	const slots = [...new Set(result.segments.map((segment) => segment.slotId))];
	return result.segments
		.filter(
			(segment) => segment.role === 'primary' && segment.slotId === (slots[slotIndex] ?? slotId),
		)
		.map((segment) => segment.title);
}

describe('schedule timeline engine', () => {
	it('uses the highest matching conditional template only inside its predicate window', () => {
		const baseMedia = media(1, 60 * 60);
		const overlayMedia = media(2, 60 * 60);
		const baseProgram = contentProgram(10, 1);
		const overlayProgram = contentProgram(11, 2);
		const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
		const overlay = template([{ programId: overlayProgram.id, startSeconds: 0 }], null, 101);
		const schedule: ChannelSchedule = {
			channelId: uuid(50),
			defaultTemplateId: base.id,
			layers: [
				{
					id: uuid(600),
					templateId: overlay.id,
					predicate: {
						type: 'all',
						children: [
							{ type: 'weekdays', values: [1], negated: false },
							{
								type: 'time-range',
								startSeconds: 12 * 3_600,
								endSeconds: 17 * 3_600,
								negated: false,
							},
						],
					},
					entryBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left' },
					exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left' },
				},
			],
			defaultFiller: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		};

		const result = generateTimeline(
			input([baseProgram, overlayProgram], [baseMedia, overlayMedia], base, {
				schedule,
				templates: [base, overlay],
			}),
		);

		const overlaySegments = result.segments.filter(
			(segment) => segment.scheduleLayerId === schedule.layers[0]!.id,
		);
		expect(overlaySegments).toHaveLength(5);
		expect(overlaySegments[0]?.start).toBe('2026-01-05T12:00:00Z');
		expect(overlaySegments.at(-1)?.finish).toBe('2026-01-05T17:00:00Z');
		expect(
			result.segments.find((segment) => segment.start === '2026-01-05T17:00:00Z'),
		).toMatchObject({
			mediaItemId: baseMedia.id,
			scheduleLayerId: null,
		});
	});

	it('lets a conditional entry boundary finish outgoing content despite the template requiring fit', () => {
		const baseMedia = media(1, 150 * 60);
		const overlayMedia = media(2, 60 * 60);
		const baseProgram = contentProgram(10, 1);
		const overlayProgram = contentProgram(11, 2);
		const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
		const overlay = template([{ programId: overlayProgram.id, startSeconds: 0 }], null, 101);
		const layerId = uuid(600);
		const schedule: ChannelSchedule = {
			...input([baseProgram], [baseMedia], base).schedule,
			layers: [
				{
					id: layerId,
					templateId: overlay.id,
					predicate: {
						type: 'time-range',
						startSeconds: 12 * 3_600,
						endSeconds: 17 * 3_600,
						negated: false,
					},
					entryBoundary: {
						policy: 'finish-left',
						maxDriftSeconds: 90 * 60,
						fallback: 'reject-start',
					},
					exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'reject-start' },
				},
			],
		};

		const result = generateTimeline(
			input([baseProgram, overlayProgram], [baseMedia, overlayMedia], base, {
				schedule,
				templates: [base, overlay],
			}),
		);
		const baseSegments = result.segments.filter(
			(segment) => segment.role === 'primary' && segment.scheduleLayerId === null,
		);
		expect(baseSegments[4]).toMatchObject({
			start: '2026-01-05T10:00:00Z',
			finish: '2026-01-05T12:30:00Z',
			truncated: false,
		});
		expect(result.segments.find((segment) => segment.scheduleLayerId === layerId)).toMatchObject({
			start: '2026-01-05T12:30:00Z',
		});
	});

	it('lets an unlimited conditional entry consume its window and cross midnight', () => {
		const baseMedia = media(1, 26 * 3_600);
		const overlayMedia = media(2, 60 * 60);
		const baseProgram = contentProgram(10, 1);
		const overlayProgram = contentProgram(11, 2);
		const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
		const overlay = template([{ programId: overlayProgram.id, startSeconds: 0 }], null, 101);
		const layerId = uuid(600);
		const schedule: ChannelSchedule = {
			...input([baseProgram], [baseMedia], base).schedule,
			layers: [
				{
					id: layerId,
					templateId: overlay.id,
					predicate: {
						type: 'time-range',
						startSeconds: 12 * 3_600,
						endSeconds: 17 * 3_600,
						negated: false,
					},
					entryBoundary: {
						policy: 'finish-left',
						maxDriftSeconds: null,
						fallback: 'reject-start',
					},
					exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'reject-start' },
				},
			],
		};

		const result = generateTimeline(
			input([baseProgram, overlayProgram], [baseMedia, overlayMedia], base, {
				schedule,
				templates: [base, overlay],
			}),
		);
		const primaries = result.segments.filter((segment) => segment.role === 'primary');
		expect(primaries).toHaveLength(1);
		expect(primaries[0]).toMatchObject({
			scheduleLayerId: null,
			start: '2026-01-05T00:00:00Z',
			finish: '2026-01-06T02:00:00Z',
			truncated: false,
		});
		expect(result.segments.some((segment) => segment.scheduleLayerId === layerId)).toBe(false);
	});

	it('lets a conditional exit boundary finish the outgoing layer item within drift', () => {
		const baseMedia = media(1, 60 * 60);
		const overlayMedia = media(2, 2 * 3_600);
		const baseProgram = contentProgram(10, 1);
		const overlayProgram = contentProgram(11, 2);
		const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
		const overlay = template([{ programId: overlayProgram.id, startSeconds: 0 }], null, 101);
		const layerId = uuid(600);
		const schedule: ChannelSchedule = {
			...input([baseProgram], [baseMedia], base).schedule,
			layers: [
				{
					id: layerId,
					templateId: overlay.id,
					predicate: {
						type: 'time-range',
						startSeconds: 12 * 3_600,
						endSeconds: 17 * 3_600,
						negated: false,
					},
					entryBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'reject-start' },
					exitBoundary: {
						policy: 'finish-left',
						maxDriftSeconds: 90 * 60,
						fallback: 'reject-start',
					},
				},
			],
		};

		const result = generateTimeline(
			input([baseProgram, overlayProgram], [baseMedia, overlayMedia], base, {
				schedule,
				templates: [base, overlay],
			}),
		);
		expect(
			result.segments.filter((segment) => segment.scheduleLayerId === layerId).at(-1),
		).toMatchObject({
			start: '2026-01-05T16:00:00Z',
			finish: '2026-01-05T18:00:00Z',
			truncated: false,
		});
		expect(
			result.segments.find(
				(segment) => segment.scheduleLayerId === null && segment.start === '2026-01-05T18:00:00Z',
			),
		).toBeDefined();
	});

	it.each(['shuffle', 'random'] as const)(
		'finds the first fitting %s item without consuming rejected candidates',
		(strategy) => {
			const longItems = [media(1, 4 * 3_600), media(2, 5 * 3_600)];
			const fitting = media(3, 2 * 3_600);
			const overlayMedia = media(4, 60 * 60);
			const baseProgram = contentProgram(10, [1, 2, 3], strategy);
			const overlayProgram = contentProgram(11, 4);
			const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
			const overlay = template([{ programId: overlayProgram.id, startSeconds: 0 }], null, 101);
			const schedule: ChannelSchedule = {
				...input([baseProgram], [...longItems, fitting], base).schedule,
				layers: [
					{
						id: uuid(600),
						templateId: overlay.id,
						predicate: {
							type: 'time-range',
							startSeconds: 3_600,
							endSeconds: 23 * 3_600,
							negated: false,
						},
						entryBoundary: {
							policy: 'finish-left',
							maxDriftSeconds: 90 * 60,
							fallback: 'reject-start',
						},
						exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'reject-start' },
					},
				],
			};
			const fixture = input(
				[baseProgram, overlayProgram],
				[...longItems, fitting, overlayMedia],
				base,
				{ schedule, templates: [base, overlay] },
			);

			const first = generateTimeline(fixture);
			const regenerated = generateTimeline(fixture);
			expect(first.segments.find((segment) => segment.scheduleLayerId === null)).toMatchObject({
				mediaItemId: fitting.id,
				finish: '2026-01-05T02:00:00Z',
			});
			expect(first.segments).toEqual(regenerated.segments);
			const state = first.proposedState.find((record) => record.consumerKey.startsWith('primary:'));
			if (strategy === 'shuffle') {
				expect(state?.value).toMatchObject({
					type: 'shuffle',
					remainingItemIds: expect.arrayContaining(longItems.map((item) => item.id)),
				});
			}
			else {
				expect(state?.value).toMatchObject({ type: 'random', counter: 1 });
			}
		},
	);

	it('preserves sequential and composite order when the next item cannot fit layer drift', () => {
		const long = media(1, 4 * 3_600);
		const short = media(2, 2 * 3_600);
		const overlayMedia = media(3, 60 * 60);
		const sequential = contentProgram(10, [1, 2]);
		const later = contentProgram(11, 2);
		const sequence = program(12, {
			type: 'sequence',
			entries: [
				{ id: uuid(701), programId: sequential.id, count: 1 },
				{ id: uuid(702), programId: later.id, count: 1 },
			],
			repeat: true,
		});
		const overlayProgram = contentProgram(13, 3);
		const base = template([{ programId: sequence.id, startSeconds: 0 }]);
		const overlay = template([{ programId: overlayProgram.id, startSeconds: 0 }], null, 101);
		const schedule: ChannelSchedule = {
			...input([sequence], [long, short], base).schedule,
			layers: [
				{
					id: uuid(600),
					templateId: overlay.id,
					predicate: {
						type: 'time-range',
						startSeconds: 3_600,
						endSeconds: 23 * 3_600,
						negated: false,
					},
					entryBoundary: {
						policy: 'finish-left',
						maxDriftSeconds: 90 * 60,
						fallback: 'reject-start',
					},
					exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'reject-start' },
				},
			],
		};

		const result = generateTimeline(
			input([sequential, later, sequence, overlayProgram], [long, short, overlayMedia], base, {
				schedule,
				templates: [base, overlay],
			}),
		);
		expect(result.segments.some((segment) => segment.mediaItemId === short.id)).toBe(false);
		expect(result.proposedState.some((record) => record.consumerKey.includes(base.id))).toBe(false);
		expect(result.issues.some((issue) => issue.code === 'boundary-start-rejected')).toBe(true);
	});

	it('uses a layer truncate fallback without requiring the outgoing template to allow truncation', () => {
		const baseMedia = media(1, 2 * 3_600);
		const overlayMedia = media(2, 60 * 60);
		const baseProgram = contentProgram(10, 1);
		const overlayProgram = contentProgram(11, 2);
		const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
		const overlay = template([{ programId: overlayProgram.id, startSeconds: 0 }], null, 101);
		const schedule: ChannelSchedule = {
			...input([baseProgram], [baseMedia], base).schedule,
			layers: [
				{
					id: uuid(600),
					templateId: overlay.id,
					predicate: {
						type: 'time-range',
						startSeconds: 3_600,
						endSeconds: 23 * 3_600,
						negated: false,
					},
					entryBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left' },
					exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'reject-start' },
				},
			],
		};

		const result = generateTimeline(
			input([baseProgram, overlayProgram], [baseMedia, overlayMedia], base, {
				schedule,
				templates: [base, overlay],
			}),
		);
		expect(result.segments[0]).toMatchObject({
			mediaItemId: baseMedia.id,
			finish: '2026-01-05T01:00:00Z',
			sourceFinishSeconds: 3_600,
			truncated: true,
		});
	});

	it('falls through explicit no-program slots but not unavailable overlay programs', () => {
		const baseMedia = media(1, 60 * 60);
		const unavailableMedia = media(2, 60 * 60, { availability: 'unconfirmed' });
		const baseProgram = contentProgram(10, 1);
		const unavailableProgram = contentProgram(11, 2);
		const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
		const fallThrough = template([{ programId: null, startSeconds: 0 }], null, 101);
		const unavailable = template(
			[{ programId: unavailableProgram.id, startSeconds: 0 }],
			null,
			102,
		);
		const layer = {
			id: uuid(600),
			predicate: { type: 'months' as const, values: [1], negated: false },
			entryBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left' } as const,
			exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left' } as const,
		};
		const fallThroughResult = generateTimeline(
			input([baseProgram], [baseMedia], base, {
				schedule: {
					...input([baseProgram], [baseMedia], base).schedule,
					layers: [{ ...layer, templateId: fallThrough.id }],
				},
				templates: [base, fallThrough],
			}),
		);
		expect(
			fallThroughResult.segments.every((segment) => segment.mediaItemId === baseMedia.id),
		).toBe(true);

		const unavailableResult = generateTimeline(
			input([baseProgram, unavailableProgram], [baseMedia, unavailableMedia], base, {
				schedule: {
					...input([baseProgram], [baseMedia], base).schedule,
					layers: [{ ...layer, templateId: unavailable.id }],
				},
				templates: [base, unavailable],
			}),
		);
		expect(unavailableResult.segments.every((segment) => segment.role === 'dead-air')).toBe(true);
	});

	it('uses the next calendar day when resolving a conditional layer exit at midnight', () => {
		const baseMedia = media(1, 60 * 60);
		const overlayMedia = media(2, 100 * 60);
		const baseProgram = contentProgram(10, 1);
		const overlayProgram = contentProgram(11, 2);
		const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
		const overlay = template(
			[
				{
					programId: overlayProgram.id,
					startSeconds: 0,
					startEligibility: { type: 'allow-overrun' },
					boundary: {
						policy: 'finish-left',
						maxDriftSeconds: 3_600,
						fallback: 'truncate-left',
					},
				},
			],
			null,
			101,
		);
		const layerId = uuid(600);
		const schedule: ChannelSchedule = {
			...input([baseProgram], [baseMedia], base).schedule,
			layers: [
				{
					id: layerId,
					templateId: overlay.id,
					predicate: { type: 'weekdays', values: [1], negated: false },
					entryBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left' },
					exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left' },
				},
			],
		};
		const result = generateTimeline(
			input([baseProgram, overlayProgram], [baseMedia, overlayMedia], base, {
				days: 2,
				schedule,
				templates: [base, overlay],
			}),
		);
		const finalOverlay = result.segments
			.filter((segment) => segment.scheduleLayerId === layerId)
			.at(-1);
		expect(finalOverlay).toMatchObject({
			finish: '2026-01-06T00:00:00Z',
			truncated: true,
		});
		expect(
			result.segments.find((segment) => segment.start === '2026-01-06T00:00:00Z'),
		).toMatchObject({ scheduleLayerId: null, mediaItemId: baseMedia.id });
	});

	it('shares persistent cursor state when one template is reused by multiple layers', () => {
		const baseMedia = media(1, 60 * 60);
		const overlayMedia = [media(2, 30 * 60), media(3, 30 * 60), media(4, 30 * 60)];
		const baseProgram = contentProgram(10, 1);
		const overlayProgram = program(11, {
			type: 'content',
			source: {
				type: 'collection',
				libraryId: uuid(900),
				itemIds: overlayMedia.map((item) => item.id),
			},
			strategy: { type: 'sequential' },
		});
		const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
		const overlay = template([{ programId: overlayProgram.id, startSeconds: 0 }], null, 101);
		const layer = (id: number, startHour: number) => ({
			id: uuid(id),
			templateId: overlay.id,
			predicate: {
				type: 'time-range' as const,
				startSeconds: startHour * 3_600,
				endSeconds: (startHour + 1) * 3_600,
				negated: false,
			},
			entryBoundary: {
				policy: 'hard' as const,
				maxDriftSeconds: 0,
				fallback: 'truncate-left' as const,
			},
			exitBoundary: {
				policy: 'hard' as const,
				maxDriftSeconds: 0,
				fallback: 'truncate-left' as const,
			},
		});
		const schedule: ChannelSchedule = {
			...input([baseProgram], [baseMedia], base).schedule,
			layers: [layer(600, 0), layer(601, 2)],
		};
		const result = generateTimeline(
			input([baseProgram, overlayProgram], [baseMedia, ...overlayMedia], base, {
				schedule,
				templates: [base, overlay],
			}),
		);
		expect(
			result.segments
				.filter((segment) => segment.scheduleLayerId === schedule.layers[0]!.id)
				.map((segment) => segment.title),
		).toEqual(['Item 2', 'Item 3']);
		expect(
			result.segments
				.filter((segment) => segment.scheduleLayerId === schedule.layers[1]!.id)
				.map((segment) => segment.title),
		).toEqual(['Item 4', 'Item 2']);
	});

	it('rejects previews whose media granularity exceeds the segment resource limit', () => {
		const ident = media(1, 1);
		const stationIds = contentProgram(10, 1);
		const daily = template([{ programId: stationIds.id, startSeconds: 0 }]);
		let caught: unknown;
		try {
			generateTimeline(input([stationIds], [ident], daily));
		}
		catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(TimelineMaterializationLimitError);
		expect(caught).toMatchObject({ limit: MAX_TIMELINE_SEGMENTS, statusCode: 422 });
	}, 20_000);

	it('materializes a fourteen-day channel made of thirty-second items', () => {
		const clip = media(1, 30);
		const clips = contentProgram(10, 1);
		const daily = template([{ programId: clips.id, startSeconds: 0 }]);

		const result = generateTimeline(input([clips], [clip], daily, { days: 14 }));

		expect(result.segments).toHaveLength(14 * 24 * 60 * 2);
		expect(result.segments.length).toBeLessThan(MAX_TIMELINE_SEGMENTS);
	}, 20_000);

	it('continues sequential episode playback across repeated daily templates', () => {
		const episodes = Array.from({ length: 20 }, (_, index) =>
			media(index + 1, 3_600, {
				kind: 'episode',
				title: `Episode ${index + 1}`,
				seasonNumber: 1,
				episodeNumber: index + 1,
			}));
		const show = contentProgram(
			10,
			episodes.map((_, index) => index + 1),
		);
		const empty = contentProgram(11, 999);
		const daily = template([
			{ programId: show.id, startSeconds: 0 },
			{ programId: empty.id, startSeconds: 6 * 3_600 },
		]);
		const result = generateTimeline(input([show, empty], episodes, daily, { days: 2 }));
		const showSegments = result.segments.filter(
			(segment) => segment.role === 'primary' && segment.slotId === daily.slots[0]!.id,
		);
		expect(showSegments.slice(0, 6).map((segment) => segment.title)).toEqual(
			episodes.slice(0, 6).map((episode) => episode.title),
		);
		expect(showSegments[6]?.title).toBe(episodes[6]?.title);
	});

	it('plays only selected seasons in season and episode order', () => {
		const showId = uuid(700);
		const seasonIds = [uuid(701), uuid(702), uuid(703)];
		const episodes = seasonIds.flatMap((groupId, seasonIndex) =>
			[1, 2].map((episodeNumber) =>
				media(710 + seasonIndex * 2 + episodeNumber, 3_600, {
					groupId,
					kind: 'episode',
					title: `S${seasonIndex + 1}E${episodeNumber}`,
					sortTitle: `Episode ${episodeNumber}`,
					seasonNumber: seasonIndex + 1,
					episodeNumber,
				})));
		const selectedSeasons = program(20, {
			type: 'content',
			source: {
				type: 'group-collection',
				libraryId: uuid(900),
				groupIds: [seasonIds[0]!, seasonIds[2]!],
			},
			strategy: { type: 'sequential' },
		});
		const daily = template([{ programId: selectedSeasons.id, startSeconds: 0 }]);
		const timelineInput = input([selectedSeasons], episodes, daily);
		timelineInput.catalog.groupParents = {
			[showId]: null,
			[seasonIds[0]!]: showId,
			[seasonIds[1]!]: showId,
			[seasonIds[2]!]: showId,
		};

		expect(primaryTitles(generateTimeline(timelineInput)).slice(0, 4)).toEqual([
			'S1E1',
			'S1E2',
			'S3E1',
			'S3E2',
		]);
	});

	it('resumes from a persisted cursor and preserves it across nominal slot edits', () => {
		const episodes = [1, 2, 3, 4, 5].map((value) =>
			media(value, 3_600, {
				kind: 'episode',
				title: `Episode ${value}`,
				seasonNumber: 1,
				episodeNumber: value,
			}));
		const show = contentProgram(10, [1, 2, 3, 4, 5]);
		const empty = contentProgram(11, 999);
		const initialTemplate = template([
			{ programId: show.id, startSeconds: 0 },
			{ programId: empty.id, startSeconds: 2 * 3_600 },
		]);
		const first = generateTimeline(input([show, empty], episodes, initialTemplate));
		const resizedTemplate = template([
			{ programId: show.id, startSeconds: 0 },
			{ programId: empty.id, startSeconds: 3 * 3_600 },
		]);
		const resumed = generateTimeline(
			input([show, empty], episodes, resizedTemplate, {
				startDate: '2026-01-06',
				state: first.proposedState,
			}),
		);
		expect(primaryTitles(resumed).slice(0, 3)).toEqual(['Episode 3', 'Episode 4', 'Episode 5']);
	});

	it('exhausts a deterministic shuffle before beginning another cycle', () => {
		const items = [
			media(1, 6 * 3_600),
			media(2, 6 * 3_600),
			media(3, 6 * 3_600),
			media(4, 6 * 3_600),
		];
		const shuffled = contentProgram(10, [1, 2, 3, 4], 'shuffle');
		const daily = template([{ programId: shuffled.id, startSeconds: 0 }]);
		const fixture = input([shuffled], items, daily, { days: 2 });
		const first = generateTimeline(fixture);
		const second = generateTimeline(fixture);
		const titles = first.segments
			.filter((entry) => entry.role === 'primary')
			.map((entry) => entry.title);
		expect(new Set(titles.slice(0, items.length))).toHaveLength(items.length);
		expect(first.segments).toEqual(second.segments);
	});

	it('reconciles removed and newly eligible media without reshuffling remaining items', () => {
		const items = [
			media(1, 6 * 3_600),
			media(2, 6 * 3_600),
			media(3, 6 * 3_600),
			media(4, 6 * 3_600),
		];
		const shuffled = contentProgram(10, [1, 2, 3, 4], 'shuffle');
		const sixHours = template([
			{ programId: shuffled.id, startSeconds: 0 },
			{ programId: contentProgram(11, 999).id, startSeconds: 6 * 3_600 },
		]);
		const first = generateTimeline(input([shuffled], items, sixHours));
		const state = first.proposedState;
		const shuffleState = state.find((record) => record.value.type === 'shuffle')?.value;
		if (!shuffleState || shuffleState.type !== 'shuffle') {
			throw new Error('Expected shuffle state');
		}

		const previousRemaining = [...shuffleState.remainingItemIds];
		const removedId = previousRemaining[0]!;
		const added = media(5, 6 * 3_600);
		const changedCatalog = [...items.filter((item) => item.id !== removedId), added];
		const resumed = generateTimeline(
			input([shuffled], changedCatalog, sixHours, { startDate: '2026-01-06', state }),
		);
		const expectedNext = previousRemaining.find((id) => id !== removedId);
		expect(resumed.segments.find((segment) => segment.role === 'primary')?.mediaItemId).toBe(
			expectedNext,
		);
	});

	it('composes counted child programs without flattening the authored sequence', () => {
		const items = [media(1, 3_600), media(2, 3_600)];
		const a = contentProgram(10, 1);
		const b = contentProgram(11, 2);
		const sequence = program(12, {
			type: 'sequence',
			entries: [
				{ id: uuid(401), programId: a.id, count: 2 },
				{ id: uuid(402), programId: b.id, count: 1 },
			],
			repeat: true,
		});
		const daily = template([
			{ programId: sequence.id, startSeconds: 0 },
			{ programId: contentProgram(13, 999).id, startSeconds: 6 * 3_600 },
		]);
		const result = generateTimeline(input([a, b, sequence], items, daily));
		expect(primaryTitles(result).slice(0, 6)).toEqual([
			'Item 1',
			'Item 1',
			'Item 2',
			'Item 1',
			'Item 1',
			'Item 2',
		]);
	});

	it('leaves an item unconsumed when it cannot start before a hard boundary', () => {
		const movie = media(1, 90 * 60);
		const movies = contentProgram(10, 1);
		const empty = contentProgram(11, 999);
		const daily = template([
			{ programId: movies.id, startSeconds: 0 },
			{ programId: empty.id, startSeconds: 60 * 60 },
		]);
		const result = generateTimeline(input([movies, empty], [movie], daily));
		expect(result.segments[0]).toMatchObject({ role: 'dead-air', truncated: false });
		expect(result.proposedState).toHaveLength(0);
	});

	it('supports truncation at a hard boundary', () => {
		const movie = media(1, 90 * 60);
		const movies = contentProgram(10, 1);
		const empty = contentProgram(11, 999);
		const daily = template([
			{
				programId: movies.id,
				startSeconds: 0,
				startEligibility: { type: 'allow-truncate' },
			},
			{ programId: empty.id, startSeconds: 60 * 60 },
		]);
		const result = generateTimeline(input([movies, empty], [movie], daily));
		expect(result.segments[0]).toMatchObject({
			role: 'primary',
			truncated: true,
			sourceFinishSeconds: 3_600,
		});
	});

	it('finishes the left item within drift but rejects excessive drift', () => {
		const movie = media(1, 70 * 60);
		const movies = contentProgram(10, 1);
		const empty = contentProgram(11, 999);
		const allowed = template([
			{
				programId: movies.id,
				startSeconds: 0,
				startEligibility: { type: 'allow-overrun' },
				boundary: { policy: 'finish-left', maxDriftSeconds: 15 * 60 },
			},
			{ programId: empty.id, startSeconds: 60 * 60 },
		]);
		const expanded = generateTimeline(input([movies, empty], [movie], allowed));
		expect(expanded.segments[0]).toMatchObject({ role: 'primary', truncated: false });
		expect(Date.parse(expanded.segments[0]!.finish) - Date.parse(expanded.segments[0]!.start)).toBe(
			movie.durationSeconds! * 1_000,
		);

		const rejectedTemplate = {
			...allowed,
			boundaries: allowed.boundaries.map((boundary, index) =>
				index === 0 ? { ...boundary, maxDriftSeconds: 5 * 60 } : boundary),
		};
		const rejected = generateTimeline(input([movies, empty], [movie], rejectedTemplate));
		expect(rejected.segments[0]?.role).toBe('dead-air');
	});

	it('finishes one crossing template item when boundary drift is unlimited', () => {
		const longMovie = media(1, 3 * 3_600);
		const movies = contentProgram(10, 1);
		const empty = contentProgram(11, 999);
		const daily = template([
			{
				programId: movies.id,
				startSeconds: 0,
				startEligibility: { type: 'allow-overrun' },
				boundary: { policy: 'finish-left', maxDriftSeconds: null },
			},
			{ programId: empty.id, startSeconds: 3_600 },
		]);

		const result = generateTimeline(input([movies, empty], [longMovie], daily));
		const primaries = result.segments.filter((segment) => segment.role === 'primary');
		expect(primaries).toHaveLength(1);
		expect(primaries[0]).toMatchObject({
			start: '2026-01-05T00:00:00Z',
			finish: '2026-01-05T03:00:00Z',
			truncated: false,
		});
	});

	it('allows the right slot to begin early at a primary item boundary', () => {
		const short = media(1, 50 * 60);
		const right = media(2, 60 * 60);
		const leftProgram = contentProgram(10, 1);
		const rightProgram = contentProgram(11, 2);
		const daily = template([
			{
				programId: leftProgram.id,
				startSeconds: 0,
				boundary: { policy: 'favor-right', maxDriftSeconds: 15 * 60 },
			},
			{ programId: rightProgram.id, startSeconds: 60 * 60 },
		]);
		const result = generateTimeline(input([leftProgram, rightProgram], [short, right], daily));
		const primaries = result.segments.filter((entry) => entry.role === 'primary');
		expect(primaries[1]?.start).toBe(primaries[0]?.finish);
		expect(Date.parse(primaries[1]!.start) - Date.parse(primaries[0]!.start)).toBe(50 * 60 * 1_000);
	});

	it('uses best-fitting filler, truncates a fallback, and never delays the next slot', () => {
		const primary = media(1, 47 * 60);
		const fillerShort = media(2, 10 * 60);
		const fillerLong = media(3, 20 * 60);
		const next = media(4, 60 * 60);
		const primaryProgram = contentProgram(10, 1);
		const fillerProgram = contentProgram(11, [2, 3]);
		const nextProgram = contentProgram(12, 4);
		const daily = template(
			[
				{ programId: primaryProgram.id, startSeconds: 0 },
				{ programId: nextProgram.id, startSeconds: 60 * 60 },
			],
			{ programId: fillerProgram.id, policy: 'best-fit-or-truncate' },
		);
		const result = generateTimeline(
			input(
				[primaryProgram, fillerProgram, nextProgram],
				[primary, fillerShort, fillerLong, next],
				daily,
			),
		);
		const filler = result.segments.filter((entry) => entry.role === 'filler');
		expect(filler.map((entry) => entry.mediaItemId)).toEqual([fillerShort.id, fillerLong.id]);
		expect(filler[1]).toMatchObject({ truncated: true, sourceFinishSeconds: 3 * 60 });
		const nextSegment = result.segments.find(
			(entry) => entry.role === 'primary' && entry.slotId === daily.slots[1]!.id,
		);
		expect(nextSegment?.start).toBe('2026-01-05T01:00:00Z');
		expect(result.proposedState.some((record) => record.consumerKey.startsWith('primary:'))).toBe(
			true,
		);
		expect(result.proposedState.some((record) => record.consumerKey.startsWith('filler:'))).toBe(
			true,
		);
	});

	it('skips missing durations with a diagnostic and preserves deterministic regeneration state', () => {
		const invalid = media(1, null);
		const valid = media(2, 60 * 60);
		const movies = contentProgram(10, [1, 2], 'shuffle');
		const daily = template([{ programId: movies.id, startSeconds: 0 }]);
		const state: SelectionStateRecord[] = [];
		const fixture = input([movies], [invalid, valid], daily, { state });
		const first = generateTimeline(fixture);
		const regenerated = generateTimeline(fixture);
		expect(first.issues.map((issue) => issue.code)).toContain('media-duration-missing');
		expect(first.segments).toEqual(regenerated.segments);
		expect(state).toEqual([]);
	});

	it('rejects catalog durations above the media scheduling limit', () => {
		const invalid = media(1, MAX_MEDIA_DURATION_MILLISECONDS / 1_000 + 1);
		const movies = contentProgram(10, 1);
		const daily = template([{ programId: movies.id, startSeconds: 0 }]);

		const result = generateTimeline(input([movies], [invalid], daily));

		expect(result.segments.every((segment) => segment.mediaItemId === null)).toBe(true);
		expect(result.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'media-duration-missing' }),
		]));
	});

	it('reports invalid multipart sequences separately from ordinary missing durations', () => {
		const invalid = media(1, null, { multipartStatus: 'incomplete' });
		const movies = contentProgram(10, 1);
		const daily = template([{ programId: movies.id, startSeconds: 0 }]);

		const result = generateTimeline(input([movies], [invalid], daily));

		expect(result.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'media-multipart-invalid' }),
		]));
	});

	it('resolves absorbed physical item IDs to their logical multipart item', () => {
		const logical = media(2, 60 * 60);
		const movies = contentProgram(10, 1);
		const daily = template([{ programId: movies.id, startSeconds: 0 }]);
		const fixture = input([movies], [logical], daily);
		fixture.catalog.mediaAliases = { [uuid(1)]: logical.id };

		const result = generateTimeline(fixture);

		expect(result.segments.find((segment) => segment.role === 'primary')?.mediaItemId)
			.toBe(logical.id);
		expect(result.issues.some((issue) => issue.code === 'source-reference-missing')).toBe(false);
	});

	it('orders music-video library queries by artist, album, disc, and track metadata', () => {
		const trackTwo = media(1, 6 * 60 * 60, {
			kind: 'music-video',
			title: 'Track 2',
			groupSortKey: 'artist a/album a',
			discNumber: 1,
			trackNumber: 2,
		});
		const trackOne = media(2, 6 * 60 * 60, {
			kind: 'music-video',
			title: 'Track 1',
			groupSortKey: 'artist a/album a',
			discNumber: 1,
			trackNumber: 1,
		});
		const laterAlbum = media(3, 6 * 60 * 60, {
			kind: 'music-video',
			title: 'Later Album',
			groupSortKey: 'artist a/album b',
			discNumber: 1,
			trackNumber: 1,
		});
		const videos = contentProgram(10, [1, 2, 3]);
		const daily = template([{ programId: videos.id, startSeconds: 0 }]);

		const result = generateTimeline(input([videos], [laterAlbum, trackTwo, trackOne], daily));

		expect(primaryTitles(result).slice(0, 3)).toEqual(['Track 1', 'Track 2', 'Later Album']);
	});

	it('continues an explicit collection when one selected item has been removed', () => {
		const surviving = media(2, 60 * 60);
		const collection = program(10, {
			type: 'content',
			source: {
				type: 'collection',
				libraryId: uuid(900),
				itemIds: [uuid(1), surviving.id],
			},
			strategy: { type: 'sequential' },
		});
		const daily = template([{ programId: collection.id, startSeconds: 0 }]);

		const result = generateTimeline(input([collection], [surviving], daily));

		expect(
			result.segments
				.filter((segment) => segment.role === 'primary')
				.every((segment) => segment.mediaItemId === surviving.id),
		).toBe(true);
		expect(
			result.issues.some(
				(issue) =>
					issue.code === 'source-reference-missing' && issue.message.includes('1 selected item'),
			),
		).toBe(true);
		expect(result.proposedState.length).toBeGreaterThan(0);
	});

	it('uses available members without dropping temporarily unavailable collection members', () => {
		const unavailable = media(1, 60 * 60, { availability: 'unconfirmed' });
		const available = media(2, 60 * 60);
		const collection = program(10, {
			type: 'content',
			source: {
				type: 'collection',
				libraryId: uuid(900),
				itemIds: [unavailable.id, available.id],
			},
			strategy: { type: 'sequential' },
		});
		const daily = template([{ programId: collection.id, startSeconds: 0 }]);

		const result = generateTimeline(input([collection], [unavailable, available], daily));

		expect(
			result.segments
				.filter((segment) => segment.role === 'primary')
				.every((segment) => segment.mediaItemId === available.id),
		).toBe(true);
		expect(result.issues.some((issue) => issue.code === 'source-unavailable')).toBe(true);
	});

	it('uses dead air without advancing state when an indexed source is temporarily unavailable', () => {
		const unavailable = media(1, 30 * 60, { availability: 'unconfirmed' });
		const movies = contentProgram(10, 1);
		const daily = template([{ programId: movies.id, startSeconds: 0 }]);

		const result = generateTimeline(input([movies], [unavailable], daily));

		expect(result.segments.every((segment) => segment.role === 'dead-air')).toBe(true);
		expect(result.issues.some((issue) => issue.code === 'source-unavailable')).toBe(true);
		expect(result.proposedState).toHaveLength(0);
	});

	it('does not advance a composite sequence past a temporarily unavailable entry', () => {
		const unavailable = media(1, 30 * 60, { availability: 'unconfirmed' });
		const available = media(2, 30 * 60);
		const first = contentProgram(10, 1);
		const second = contentProgram(11, 2);
		const sequence = program(12, {
			type: 'sequence',
			entries: [
				{ id: uuid(701), programId: first.id, count: 1 },
				{ id: uuid(702), programId: second.id, count: 1 },
			],
			repeat: true,
		});
		const daily = template([{ programId: sequence.id, startSeconds: 0 }]);

		const result = generateTimeline(
			input([first, second, sequence], [unavailable, available], daily),
		);

		expect(result.segments.some((segment) => segment.mediaItemId === available.id)).toBe(false);
		expect(result.proposedState).toHaveLength(0);
	});

	it('uses real instants across DST and permits media to cross midnight', () => {
		const marathon = media(1, 24 * 3_600);
		const program = contentProgram(10, 1);
		const daily = template([
			{
				programId: program.id,
				startSeconds: 0,
				startEligibility: { type: 'allow-overrun' },
				boundary: { policy: 'finish-left', maxDriftSeconds: 2 * 3_600 },
			},
		]);
		const result = generateTimeline(
			input([program], [marathon], daily, {
				timeZone: 'America/Los_Angeles',
				startDate: '2026-03-08',
			}),
		);
		expect(result.segments[0]?.start).toBe('2026-03-08T08:00:00Z');
		expect(result.segments[0]?.finish).toBe('2026-03-09T08:00:00Z');
	});

	it('preserves measured millisecond duration across consecutive items', () => {
		const measured = media(1, 3_600.125);
		const movies = contentProgram(10, 1);
		const daily = template([{ programId: movies.id, startSeconds: 0 }]);
		const result = generateTimeline(input([movies], [measured], daily));

		expect(result.segments[0]?.finish).toContain('01:00:00.125');
		expect(result.segments[1]?.finish).toContain('02:00:00.25');
	});
});
