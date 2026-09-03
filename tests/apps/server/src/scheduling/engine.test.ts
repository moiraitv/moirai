import { describe, expect, it } from 'vitest';
import type {
	ChannelSchedule,
	ProgramConfig,
	ScheduleBoundary,
	ScheduleSlot,
	ScheduleTemplate,
	SchedulableMedia,
	SchedulingProgram,
	SelectedMediaSort,
	SelectionStateRecord,
} from '@moirai/shared';
import {
	MAX_MEDIA_DURATION_MILLISECONDS,
	MAX_TIMELINE_ISSUE_OCCURRENCES,
	MAX_TIMELINE_SEGMENTS,
	SECONDS_PER_SCHEDULING_DAY,
} from '@moirai/shared';
import {
	generateTimeline,
	generateTimelineDetailed,
	TimelineMaterializationLimitError,
	type GenerateTimelineInput,
} from '@server/scheduling/engine.js';
import { stableJsonFingerprint } from '@server/stable-json.js';
import { mergeTimelineIssues, timelineIssuesInRange, TimelineIssueLimitError } from '@server/scheduling/timeline-issues.js';

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
	strategy: 'sequential' | 'shuffle' | 'random' | 'weighted-random' = 'sequential',
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
		earlyStartMaxDriftSeconds:
      slotFixtures[index]!.boundary?.earlyStartMaxDriftSeconds ?? 0,
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
	it.each(['best-fit-only', 'next-fit-only', 'best-fit-or-truncate', 'next-truncate'] as const)('fits early incoming %s filler against its nominal boundary across midnight', (policy) => {
		const outgoing = contentProgram(10, 1);
		const filler = contentProgram(11, 2);
		const daily = template([
			{ programId: null, startSeconds: 0 },
			{
				programId: outgoing.id, startSeconds: 3600,
				boundary: { policy: 'finish-left', maxDriftSeconds: 0, fallback: 'favor-right', earlyStartMaxDriftSeconds: 3600 },
			},
		]);
		const options = input([outgoing, filler], [media(1, 22 * 3600), media(2, 90 * 60)], daily);
		options.schedule.defaultFiller = { programId: filler.id, policy };
		const first = generateTimelineDetailed(options);
		expect(first.segments.at(-1)).toMatchObject({
			role: 'filler', start: '2026-01-05T23:00:00Z', finish: '2026-01-06T00:30:00Z', truncated: false,
		});
		expect(first.continuation).toMatchObject({ date: '2026-01-06', phase: 'filler', hadPrimary: false });
		const tail = generateTimelineDetailed({
			...options, startDate: '2026-01-06', initialCursor: first.continuationAt,
			state: first.proposedState, initialContinuation: JSON.parse(JSON.stringify(first.continuation)),
		});
		const whole = generateTimelineDetailed({ ...options, days: 2 });
		expect([...first.segments, ...tail.segments]).toEqual(whole.segments);
		expect(tail.proposedState.map((record) => ({ ...record, updatedAt: '' })))
			.toEqual(whole.proposedState.map((record) => ({ ...record, updatedAt: '' })));
	});

	it('retains primary progress for an early incoming favor-right slot across continuation', () => {
		const incoming = program(10, {
			type: 'content', source: { type: 'collection', libraryId: uuid(900), itemIds: [uuid(1), uuid(2)], sort: { type: 'date-added', direction: 'asc' } },
			strategy: { type: 'sequential' },
		});
		const outgoing = contentProgram(11, 3);
		const daily = template([
			{ programId: incoming.id, startSeconds: 0, boundary: { policy: 'favor-right', maxDriftSeconds: 40 * 60 } },
			{
				programId: outgoing.id, startSeconds: 3600,
				boundary: { policy: 'finish-left', maxDriftSeconds: 0, fallback: 'favor-right', earlyStartMaxDriftSeconds: 40 * 60 },
			},
		]);
		daily.slots[0]!.stateScope = 'occurrence';
		const options = input([incoming, outgoing], [media(1, 40 * 60), media(2, 2 * 3600), media(3, 23 * 3600)], daily);
		const first = generateTimelineDetailed(options);
		expect(first.segments.at(-1)).toMatchObject({ start: '2026-01-05T23:40:00Z', finish: '2026-01-06T00:20:00Z', programId: incoming.id });
		expect(first.continuation).toMatchObject({ phase: 'primary', hadPrimary: true, date: '2026-01-06' });
		const tail = generateTimelineDetailed({
			...options, startDate: '2026-01-06', initialCursor: first.continuationAt,
			state: first.proposedState, initialContinuation: JSON.parse(JSON.stringify(first.continuation)),
		});
		expect(tail.segments[0]).toMatchObject({ programId: outgoing.id, start: '2026-01-06T00:20:00Z' });
		expect([...first.segments, ...tail.segments]).toEqual(generateTimelineDetailed({ ...options, days: 2 }).segments);
	});

	it.each(['random', 'weighted-random', 'shuffle'] as const)('tries a fitting outgoing %s item before an ordinary early fallback', (strategy) => {
		const outgoing = program(10, {
			type: 'content',
			source: { type: 'collection', libraryId: uuid(900), itemIds: [uuid(1), uuid(2)], sort: { type: 'date-added', direction: 'asc' } },
			strategy: { type: strategy, seed: 'late-first' },
		});
		const incoming = contentProgram(11, 3);
		const daily = template([
			{
				programId: outgoing.id, startSeconds: 0, startEligibility: { type: 'allow-overrun' },
				boundary: { policy: 'finish-left', maxDriftSeconds: 1800, fallback: 'favor-right', earlyStartMaxDriftSeconds: 3600 },
			},
			{ programId: incoming.id, startSeconds: 3600 },
		]);
		const options = input([outgoing, incoming], [media(1, 3600), media(2, 3600), media(3, 3600)], daily);
		const preferredId = generateTimeline(options).segments[0]!.mediaItemId;
		// Make the strategy's first choice too long, leaving one eligible late finish.
		for (const item of options.catalog.media.slice(0, 2)) {
			item.durationSeconds = item.id === preferredId ? 3 * 3600 : 75 * 60;
		}
		const result = generateTimeline(options);
		expect(result.segments[0]).toMatchObject({
			programId: outgoing.id, start: '2026-01-05T00:00:00Z', finish: '2026-01-05T01:15:00Z', truncated: false,
		});
		expect(result.segments[0]?.mediaItemId).not.toBe(preferredId);
		if (strategy === 'shuffle') {
			const value = result.proposedState.find((record) => record.consumerKey.endsWith(outgoing.id))?.value;
			expect(value).toMatchObject({ remainingItemIds: [preferredId] });
		}
	});

	it.each([
		{ eligibility: { type: 'require-fit' } as const, fittingMinutes: 60 },
		{ eligibility: { type: 'within-drift', maxDriftSeconds: 900 } as const, fittingMinutes: 75 },
	])('respects $eligibility.type when searching before early fallback', ({ eligibility, fittingMinutes }) => {
		const outgoing = program(10, {
			type: 'content',
			source: { type: 'collection', libraryId: uuid(900), itemIds: [uuid(1), uuid(2)], sort: { type: 'date-added', direction: 'asc' } },
			strategy: { type: 'random', seed: 'slot-eligibility' },
		});
		const incoming = contentProgram(11, 3);
		const daily = template([
			{
				programId: outgoing.id, startSeconds: 0, startEligibility: eligibility,
				boundary: { policy: 'finish-left', maxDriftSeconds: 3600, fallback: 'favor-right', earlyStartMaxDriftSeconds: 3600 },
			},
			{ programId: incoming.id, startSeconds: 3600 },
		]);
		const options = input([outgoing, incoming], [media(1, 3600), media(2, 3600), media(3, 3600)], daily);
		const preferredId = generateTimeline(options).segments[0]!.mediaItemId;
		for (const item of options.catalog.media.slice(0, 2)) {
			item.durationSeconds = item.id === preferredId ? 90 * 60 : fittingMinutes * 60;
		}
		const result = generateTimeline(options);
		expect(result.segments[0]?.programId).toBe(outgoing.id);
		expect(result.segments[0]?.mediaItemId).not.toBe(preferredId);
		expect(Date.parse(result.segments[0]!.finish) - Date.parse(result.segments[0]!.start)).toBe(fittingMinutes * 60_000);
	});

	it.each(['template', 'layer-entry', 'layer-exit'] as const)('only warns about the gap left after a %s filler handoff', (origin) => {
		const primary = contentProgram(10, 1);
		const filler = contentProgram(11, 2);
		const next = contentProgram(12, 3);
		const base = template([
			{ programId: primary.id, startSeconds: 0 },
			{ programId: next.id, startSeconds: 3600 },
		], { programId: filler.id, policy: 'best-fit-only' });
		const options = input([primary, filler, next], [media(1, 50 * 60), media(2, 5 * 60), media(3, 3600)], base);
		if (origin !== 'template') {
			const overlay = template([{ programId: origin === 'layer-entry' ? next.id : primary.id, startSeconds: 0 }], base.defaultFiller, 101);
			options.templates = [base, overlay];
			options.schedule.layers = [{
				id: uuid(600), templateId: overlay.id,
				predicate: { type: 'time-range', startSeconds: origin === 'layer-entry' ? 3600 : 0, endSeconds: origin === 'layer-entry' ? 86400 : 3600, negated: false },
				entryBoundary: { policy: 'finish-left', maxDriftSeconds: 0, fallback: 'reject-start' },
				exitBoundary: { policy: 'finish-left', maxDriftSeconds: 0, fallback: 'reject-start' },
			}];
		}
		const filled = generateTimeline(options);
		expect(filled.segments.filter((entry) => entry.role === 'filler')).toHaveLength(2);
		expect(filled.segments.some((entry) => entry.role === 'dead-air')).toBe(false);
		expect(filled.issues.filter((entry) => entry.code === 'boundary-start-rejected')).toEqual([]);

		options.catalog.media[1]!.durationSeconds = 7 * 60;
		const partial = generateTimeline(options);
		const gap = partial.segments.find((entry) => entry.role === 'dead-air');
		expect(gap).toMatchObject({ start: '2026-01-05T00:57:00Z', finish: '2026-01-05T01:00:00Z' });
		const warning = partial.issues.find((entry) => entry.code === 'boundary-start-rejected');
		expect(warning?.occurrences).toEqual([{ start: gap!.start, finish: gap!.finish, boundaryOrigin: origin }]);
		expect(warning?.occurrenceCount).toBe(1);
	});

	it('chains conditional entry and exit fallbacks before the requested end', () => {
		const rejected = contentProgram(10, 1);
		const playable = contentProgram(11, 2);
		const early = { policy: 'finish-left' as const, maxDriftSeconds: 0, fallback: 'favor-right' as const, earlyStartMaxDriftSeconds: 2 * 3600 };
		const base = template([{ programId: playable.id, startSeconds: 0, boundary: early }]);
		const overlay = template([{ programId: rejected.id, startSeconds: 0 }], null, 101);
		const options = input([rejected, playable], [media(1, 4 * 3600), media(2, 22 * 3600)], base, { templates: [base, overlay] });
		options.schedule.layers = [{
			id: uuid(600), templateId: overlay.id,
			predicate: { type: 'all', children: [
				{ type: 'dates', values: ['2026-01-06'], negated: false },
				{ type: 'time-range', startSeconds: 0, endSeconds: 3600, negated: false },
			] },
			entryBoundary: early, exitBoundary: { ...early, earlyStartMaxDriftSeconds: 3 * 3600 },
		}];
		const first = generateTimelineDetailed(options);
		const whole = generateTimelineDetailed({ ...options, days: 2 });
		expect(first.segments).toEqual(whole.segments.filter((segment) => segment.start < '2026-01-06T00:00:00Z'));
		expect(first.segments[1]).toMatchObject({ role: 'primary', programId: playable.id, start: '2026-01-05T22:00:00Z' });
		expect(first.issues.filter((issue) => issue.code === 'boundary-start-rejected')).toEqual([]);
	});

	it('chains early handoffs past nominal midnight without changing the committed prefix', () => {
		const rejected = contentProgram(10, 1);
		const playable = contentProgram(11, 2);
		const daily = template([
			{
				programId: rejected.id, startSeconds: 0,
				boundary: { policy: 'finish-left', maxDriftSeconds: 0, fallback: 'favor-right', earlyStartMaxDriftSeconds: 3 * 3600 },
			},
			{
				programId: playable.id, startSeconds: 3600,
				boundary: { policy: 'finish-left', maxDriftSeconds: 0, fallback: 'favor-right', earlyStartMaxDriftSeconds: 2 * 3600 },
			},
		]);
		const options = input([rejected, playable], [media(1, 4 * 3600), media(2, 22 * 3600)], daily);
		const first = generateTimelineDetailed(options);
		const whole = generateTimelineDetailed({ ...options, days: 2 });
		expect(first.segments).toEqual(whole.segments.filter((segment) => segment.start < '2026-01-06T00:00:00Z'));
		expect(first.segments[1]).toMatchObject({ role: 'primary', programId: playable.id, start: '2026-01-05T22:00:00Z' });
		const tail = generateTimelineDetailed({ ...options, startDate: '2026-01-06', initialCursor: first.continuationAt, state: first.proposedState });
		expect([...first.segments, ...tail.segments]).toEqual(whole.segments);
	});

	it('records next-day displacement while its boundary cause is still known and preserves it across a split', () => {
		const short = contentProgram(10, 1);
		const long = contentProgram(11, 2);
		const daily = template([
			{ programId: short.id, startSeconds: 0 },
			{
				programId: long.id, startSeconds: 3600, startEligibility: { type: 'allow-overrun' },
				boundary: { policy: 'finish-left', maxDriftSeconds: null },
			},
		]);
		const options = input([short, long], [media(1, 3600), media(2, 29 * 3600)], daily);
		const first = generateTimelineDetailed(options);
		expect(first.continuationAt).toBe('2026-01-06T06:00:00Z');
		expect(first.issues.find((entry) => entry.code === 'slot-displaced')?.occurrences).toEqual([{
			start: '2026-01-06T00:00:00Z', finish: '2026-01-06T01:00:00Z', boundaryOrigin: 'template',
		}]);
		const tail = generateTimelineDetailed({ ...options, startDate: '2026-01-06', initialCursor: first.continuationAt, state: first.proposedState });
		const merged = mergeTimelineIssues(first.issues, tail.issues, '2026-01-05T00:00:00Z', first.continuationAt, tail.continuationAt);
		const whole = generateTimelineDetailed({ ...options, days: 2 });
		expect([...first.segments, ...tail.segments]).toEqual(whole.segments);
		expect(timelineIssuesInRange(merged, '2026-01-05T00:00:00Z', tail.continuationAt))
			.toEqual(timelineIssuesInRange(whole.issues, '2026-01-05T00:00:00Z', tail.continuationAt));
	});

	it.each([1, 14])('completes a %i-day window after an early midnight fallback without consuming the following day', (days) => {
		const incoming = program(10, {
			type: 'content', source: { type: 'collection', libraryId: uuid(900), itemIds: [uuid(1), uuid(2)], sort: { type: 'date-added', direction: 'asc' } },
			strategy: { type: 'sequential' },
		});
		const outgoing = contentProgram(11, 3);
		const daily = template([
			{ programId: incoming.id, startSeconds: 0 },
			{
				programId: outgoing.id, startSeconds: 3600, startEligibility: { type: 'allow-overrun' },
				boundary: { policy: 'finish-left', maxDriftSeconds: 0, fallback: 'favor-right', earlyStartMaxDriftSeconds: 3600 },
			},
		]);
		const options = input([incoming, outgoing], [media(1, 3600), media(2, 3600), media(3, 22 * 3600)], daily, { days });
		const result = generateTimelineDetailed(options);
		const expectedEnd = new Date(Date.parse(`${options.startDate}T00:00:00Z`) + days * 86400_000).toISOString();
		expect(Date.parse(result.continuationAt)).toBe(Date.parse(expectedEnd));
		expect(result.segments.at(-1)).toMatchObject({ programId: incoming.id, role: 'primary' });
		expect(Date.parse(result.segments.at(-1)!.finish)).toBe(Date.parse(expectedEnd));
		expect(result.segments.every((entry) => entry.role === 'primary')).toBe(true);
		for (let index = 1; index < result.segments.length; index += 1) {
			expect(result.segments[index]?.start).toBe(result.segments[index - 1]?.finish);
		}
		const continued = generateTimelineDetailed({
			...options, startDate: expectedEnd.slice(0, 10), days: 1,
			initialCursor: result.continuationAt, state: result.proposedState,
		});
		const uninterrupted = generateTimelineDetailed({ ...options, days: days + 1 });
		expect([...result.segments, ...continued.segments]).toEqual(uninterrupted.segments);
	});

	it.each(['entry', 'exit'] as const)('completes early midnight layer-%s handoffs using the correct next-day program', (side) => {
		const incoming = contentProgram(10, 1);
		const outgoing = contentProgram(11, 2);
		const base = template([{ programId: side === 'entry' ? outgoing.id : incoming.id, startSeconds: 0 }]);
		const overlay = template([{ programId: side === 'entry' ? incoming.id : outgoing.id, startSeconds: 0 }], null, 101);
		const options = input([incoming, outgoing], [media(1, 7200), media(2, 23 * 3600)], base, { templates: [base, overlay] });
		const hard = { policy: 'hard' as const, maxDriftSeconds: 0, fallback: 'truncate-left' as const, earlyStartMaxDriftSeconds: 0 };
		const early = { policy: 'finish-left' as const, maxDriftSeconds: 0, fallback: 'favor-right' as const, earlyStartMaxDriftSeconds: 3600 };
		options.schedule.layers = [{
			id: uuid(600), templateId: overlay.id,
			predicate: { type: 'dates', values: [side === 'entry' ? '2026-01-06' : '2026-01-05'], negated: false },
			entryBoundary: side === 'entry' ? early : hard,
			exitBoundary: side === 'exit' ? early : hard,
		}];
		const result = generateTimelineDetailed(options);
		expect(result.segments).toHaveLength(2);
		expect(result.segments[1]).toMatchObject({
			programId: incoming.id, start: '2026-01-05T23:00:00Z', finish: '2026-01-06T01:00:00Z',
			scheduleLayerId: side === 'entry' ? uuid(600) : null,
		});
		expect(result.continuationAt).toBe('2026-01-06T01:00:00Z');
	});

	it('indexes large invalid-media catalogs within the aggregate diagnostic budget', () => {
		const invalidItems = Array.from({ length: 1000 }, (_, index) => media(index + 2, null));
		const selected = contentProgram(10, [1, 2]);
		const daily = template([{ programId: selected.id, startSeconds: 0 }]);
		const result = generateTimelineDetailed(input([selected], [media(1, 3600), ...invalidItems], daily));
		expect(result.segments).toHaveLength(24);
		expect(result.issues).toHaveLength(invalidItems.length);
		for (const issue of result.issues) {
			expect(issue.occurrenceCount).toBe(24);
			expect(issue.occurrences).toHaveLength(24);
		}
	}, 30_000);

	it('rejects a dense fourteen-day catalog before its diagnostic state can grow without bound', () => {
		const selected = contentProgram(10, [1, 2]);
		const daily = template([{ programId: selected.id, startSeconds: 0 }]);
		const invalid = Array.from({ length: 1000 }, (_, index) => media(index + 2, null));
		expect(() => generateTimelineDetailed(input([selected], [media(1, 30), ...invalid], daily, { days: 14 })))
			.toThrow(TimelineIssueLimitError);
	});

	it('completes an early midnight handoff with explicit dead air when the next-day source is unavailable', () => {
		const outgoing = contentProgram(10, 1);
		const missing = contentProgram(11, 2);
		const base = template([{ programId: outgoing.id, startSeconds: 0 }]);
		const overlay = template([{ programId: missing.id, startSeconds: 0 }], null, 101);
		const options = input([outgoing, missing], [media(1, 23 * 3600)], base, { templates: [base, overlay] });
		const early = { policy: 'finish-left' as const, maxDriftSeconds: 0, fallback: 'favor-right' as const, earlyStartMaxDriftSeconds: SECONDS_PER_SCHEDULING_DAY };
		options.schedule.layers = [{
			id: uuid(600), templateId: overlay.id,
			predicate: { type: 'dates', values: ['2026-01-06'], negated: false },
			entryBoundary: early, exitBoundary: early,
		}];
		const result = generateTimelineDetailed(options);
		expect(result.segments.at(-1)).toMatchObject({ role: 'dead-air', start: '2026-01-05T23:00:00Z', finish: '2026-01-06T00:00:00Z' });
		expect(result.continuationAt).toBe('2026-01-06T00:00:00Z');
		expect(result.issues.some((issue) => issue.code === 'source-reference-missing')).toBe(true);
	});

	it('uses decayed preference weights while retaining baseline variety and no immediate repeat', () => {
		const items = [media(1, 60), media(2, 60), media(3, 60)];
		const weighted = contentProgram(10, [1, 2, 3], 'weighted-random');
		const daily = template([{ programId: weighted.id, startSeconds: 0 }]);
		const result = generateTimeline(input([weighted], items, daily, {
			viewingPreferences: {
				itemScores: { [uuid(1)]: 1_000 },
				showScores: {},
			},
		}));
		const titles = primaryTitles(result);
		const favoredCount = titles.filter((title) => title === 'Item 1').length;
		expect(favoredCount).toBeGreaterThan(titles.filter((title) => title === 'Item 2').length);
		expect(new Set(titles)).toEqual(new Set(['Item 1', 'Item 2', 'Item 3']));
		expect(titles.some((title, index) => index > 0 && title === titles[index - 1])).toBe(false);
	});

	it('avoids an exact-media cross-channel overlap when another candidate is available', () => {
		const items = [media(1, 3_600), media(2, 3_600)];
		const sequential = contentProgram(10, [1, 2]);
		const daily = template([{ programId: sequential.id, startSeconds: 0 }]);
		const result = generateTimeline(input([sequential], items, daily, {
			occupiedMedia: [{
				mediaItemId: uuid(1),
				start: '2026-01-05T00:00:00Z',
				finish: '2026-01-06T00:00:00Z',
			}],
		}));
		expect(new Set(primaryTitles(result))).toEqual(new Set(['Item 2']));
	});

	it('continues sequential state from a temporarily colliding last item', () => {
		const items = [media(1, 60), media(2, 60), media(3, 60)];
		const sequential = contentProgram(10, [1, 2, 3]);
		const daily = template([{ programId: sequential.id, startSeconds: 0 }]);
		const first = generateTimeline(input([sequential], items, daily, {
			initialCursor: '2026-01-05T23:59:00Z',
		}));

		const resumed = generateTimeline(input([sequential], items, daily, {
			startDate: '2026-01-06',
			initialCursor: '2026-01-06T23:59:00Z',
			state: first.proposedState,
			occupiedMedia: [{
				mediaItemId: uuid(1),
				start: '2026-01-06T00:00:00Z',
				finish: '2026-01-07T00:00:00Z',
			}],
		}));

		expect(first.segments.find((segment) => segment.role === 'primary')?.mediaItemId).toBe(uuid(1));
		expect(resumed.segments.find((segment) => segment.role === 'primary')?.mediaItemId).toBe(uuid(2));
	});

	it('does not report slots ending before an incremental cursor as displaced', () => {
		const earlier = contentProgram(10, 1);
		const current = contentProgram(11, 2);
		const daily = template([
			{ programId: earlier.id, startSeconds: 0 },
			{ programId: current.id, startSeconds: 3 * 3_600 },
		]);

		const result = generateTimeline(input(
			[earlier, current],
			[media(1, 60 * 60), media(2, 60 * 60)],
			daily,
			{ initialCursor: '2026-01-05T04:00:00Z' },
		));

		expect(result.issues.some((issue) => issue.code === 'slot-displaced')).toBe(false);
		expect(result.segments.find((segment) => segment.role === 'primary')?.start)
			.toBe('2026-01-05T04:00:00Z');
	});

	it('reports the exact future slot consumed by a genuine boundary overrun', () => {
		const overrunning = contentProgram(10, 1);
		const displaced = contentProgram(11, 2);
		const resumed = contentProgram(12, 3);
		const daily = template([
			{
				programId: overrunning.id,
				startSeconds: 0,
				startEligibility: { type: 'allow-overrun' },
				boundary: { policy: 'finish-left', maxDriftSeconds: 2 * 3_600 },
			},
			{ programId: displaced.id, startSeconds: 3 * 3_600 },
			{ programId: resumed.id, startSeconds: 4 * 3_600 },
		]);

		const result = generateTimeline(input(
			[overrunning, displaced, resumed],
			[media(1, 5 * 3_600), media(2, 60 * 60), media(3, 60 * 60)],
			daily,
		));
		const issue = result.issues.find((candidate) => candidate.code === 'slot-displaced');

		expect(issue?.message).toContain('Reduce its boundary drift');
		expect(issue).toMatchObject({
			occurrenceCount: 1,
			occurrences: [{
				start: '2026-01-05T03:00:00Z',
				finish: '2026-01-05T04:00:00Z',
				boundaryOrigin: 'template',
			}],
		});
	});

	it('counts fit-then-fallback filler warnings once per cursor beyond the detail cap', () => {
		const filler = contentProgram(10, [1, 2]);
		const daily = template([{ programId: null, startSeconds: 0 }]);
		const testInput = input([filler], [media(1, 1_000), media(2, null)], daily);
		testInput.schedule.defaultFiller = { programId: filler.id, policy: 'best-fit-or-truncate' };

		const result = generateTimelineDetailed(testInput);
		const warning = result.issues.find((entry) => entry.code === 'media-duration-missing');
		const fillerSegments = result.segments.filter((entry) => entry.role === 'filler');
		expect(fillerSegments.length).toBeGreaterThan(MAX_TIMELINE_ISSUE_OCCURRENCES);
		expect(fillerSegments.at(-1)?.truncated).toBe(true);
		expect(warning?.occurrenceCount).toBe(fillerSegments.length);
		expect(warning?.occurrenceCounts).toHaveLength(fillerSegments.length);
		expect(warning?.occurrences).toHaveLength(MAX_TIMELINE_ISSUE_OCCURRENCES);
		expect(generateTimeline(testInput).issues[0]).not.toHaveProperty('occurrenceCounts');
	});

	it('keeps the causative entry boundary while an outgoing item displaces a whole conditional window', () => {
		const outgoing = contentProgram(10, 1);
		const incoming = contentProgram(11, 2);
		const base = template([{ programId: outgoing.id, startSeconds: 0 }]);
		const overlay = template([
			{ programId: incoming.id, startSeconds: 0 },
			{ programId: incoming.id, startSeconds: 2 * 3_600 },
		], null, 101);
		const testInput = input([outgoing, incoming], [media(1, 6 * 3_600), media(2, 3_600)], base);
		const layerId = uuid(600);
		testInput.templates = [base, overlay];
		testInput.schedule.layers = [{
			id: layerId,
			templateId: overlay.id,
			predicate: { type: 'time-range', startSeconds: 3_600, endSeconds: 3 * 3_600, negated: false },
			entryBoundary: { policy: 'finish-left', maxDriftSeconds: 6 * 3_600, fallback: 'reject-start' },
			exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left' },
		}];

		const result = generateTimeline(testInput);
		const displaced = result.issues.filter((entry) => entry.code === 'slot-displaced');
		expect(displaced).toHaveLength(2);
		expect(displaced.map((entry) => entry.slotId)).toEqual(overlay.slots.map((slot) => slot.id));
		for (const [index, entry] of displaced.entries()) {
			expect(entry).toMatchObject({
				scheduleLayerId: layerId,
				templateId: overlay.id,
				occurrences: [{
					start: `2026-01-05T0${index + 1}:00:00Z`,
					finish: `2026-01-05T0${index + 2}:00:00Z`,
					boundaryOrigin: 'layer-entry',
				}],
			});
		}
	});

	it('retains a temporarily colliding item in shuffle cycle state', () => {
		const items = [media(1, 60), media(2, 60), media(3, 60)];
		const shuffled = contentProgram(10, [1, 2, 3], 'shuffle');
		const daily = template([{ programId: shuffled.id, startSeconds: 0 }]);
		const first = generateTimeline(input([shuffled], items, daily, {
			initialCursor: '2026-01-05T23:59:00Z',
		}));
		const firstState = first.proposedState.find((record) => record.value.type === 'shuffle');
		if (!firstState || firstState.value.type !== 'shuffle' || !firstState.value.lastItemId) {
			throw new Error('Expected initialized shuffle state');
		}

		const resumed = generateTimeline(input([shuffled], items, daily, {
			startDate: '2026-01-06',
			initialCursor: '2026-01-06T23:59:00Z',
			state: first.proposedState,
			occupiedMedia: [{
				mediaItemId: firstState.value.lastItemId,
				start: '2026-01-06T00:00:00Z',
				finish: '2026-01-07T00:00:00Z',
			}],
		}));
		const resumedState = resumed.proposedState.find((record) => record.value.type === 'shuffle');
		if (!resumedState || resumedState.value.type !== 'shuffle') {
			throw new Error('Expected resumed shuffle state');
		}

		expect(resumed.segments.find((segment) => segment.role === 'primary')?.mediaItemId)
			.not.toBe(firstState.value.lastItemId);
		expect(new Set(resumedState.value.cycleItemIds)).toEqual(new Set(items.map((item) => item.id)));
	});

	it('falls back to normal selection when every candidate conflicts', () => {
		const item = media(1, 3_600);
		const sequential = contentProgram(10, 1);
		const daily = template([{ programId: sequential.id, startSeconds: 0 }]);
		const result = generateTimeline(input([sequential], [item], daily, {
			occupiedMedia: [{
				mediaItemId: item.id,
				start: '2026-01-05T00:00:00Z',
				finish: '2026-01-06T00:00:00Z',
			}],
		}));
		expect(primaryTitles(result)).toContain('Item 1');
	});
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
		expect(result.issues.find((issue) => issue.code === 'boundary-start-rejected')?.message)
			.toBe('No outgoing item can finish within 90 minutes of the conditional boundary. Selection state was preserved.');
	});

	it('finishes an outgoing item before using the early incoming fallback', () => {
		const first = media(1, 2 * 3_600);
		const fitting = media(2, 2 * 3_600);
		const overlayMedia = media(3, 60 * 60);
		const baseProgram = contentProgram(10, [1, 2]);
		const overlayProgram = contentProgram(11, 3);
		const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
		const overlay = template([{ programId: overlayProgram.id, startSeconds: 0 }], null, 101);
		const layerId = uuid(600);
		const schedule: ChannelSchedule = {
			...input([baseProgram], [first, fitting], base).schedule,
			layers: [{
				id: layerId,
				templateId: overlay.id,
				predicate: {
					type: 'time-range',
					startSeconds: 3 * 3_600,
					endSeconds: 23 * 3_600,
					negated: false,
				},
				entryBoundary: {
					policy: 'finish-left',
					maxDriftSeconds: 90 * 60,
					fallback: 'favor-right',
					earlyStartMaxDriftSeconds: 75 * 60,
				},
				exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'reject-start' },
			}],
		};

		const result = generateTimeline(input(
			[baseProgram, overlayProgram],
			[first, fitting, overlayMedia],
			base,
			{ schedule, templates: [base, overlay] },
		));
		const firstLayerSegment = result.segments.find((segment) => segment.scheduleLayerId === layerId);
		expect(firstLayerSegment?.start).toBe('2026-01-05T04:00:00Z');
		expect(result.segments.some((segment) => segment.role === 'dead-air')).toBe(false);
	});

	it('starts incoming layer content early when no outgoing item fits the late drift', () => {
		const first = media(1, 2 * 3_600);
		const tooLong = media(2, 4 * 3_600);
		const overlayMedia = media(3, 60 * 60);
		const baseProgram = contentProgram(10, [1, 2]);
		const overlayProgram = contentProgram(11, 3);
		const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
		const overlay = template([{ programId: overlayProgram.id, startSeconds: 0 }], null, 101);
		const layerId = uuid(600);
		const schedule: ChannelSchedule = {
			...input([baseProgram], [first, tooLong], base).schedule,
			layers: [{
				id: layerId,
				templateId: overlay.id,
				predicate: {
					type: 'time-range',
					startSeconds: 3 * 3_600,
					endSeconds: 23 * 3_600,
					negated: false,
				},
				entryBoundary: {
					policy: 'finish-left',
					maxDriftSeconds: 90 * 60,
					fallback: 'favor-right',
					earlyStartMaxDriftSeconds: 75 * 60,
				},
				exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'reject-start' },
			}],
		};

		const result = generateTimeline(input(
			[baseProgram, overlayProgram],
			[first, tooLong, overlayMedia],
			base,
			{ schedule, templates: [base, overlay] },
		));
		const firstLayerSegment = result.segments.find((segment) => segment.scheduleLayerId === layerId);
		expect(firstLayerSegment?.start).toBe('2026-01-05T02:00:00Z');
		expect(result.segments.some((segment) =>
			segment.role === 'dead-air'
			&& segment.start === '2026-01-05T02:00:00Z'
			&& segment.finish === '2026-01-05T03:00:00Z')).toBe(false);
		const state = result.proposedState.find((record) => record.consumerKey.includes(base.id));
		expect(state?.value).toMatchObject({ type: 'sequential', lastItemId: first.id });
	});

	it('starts lower-priority content early through a conditional exit fallback', () => {
		const first = media(1, 2 * 3_600);
		const tooLong = media(2, 4 * 3_600);
		const baseMedia = media(3, 60 * 60);
		const overlayProgram = contentProgram(10, [1, 2]);
		const baseProgram = contentProgram(11, 3);
		const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
		const overlay = template([{ programId: overlayProgram.id, startSeconds: 0 }], null, 101);
		const layerId = uuid(600);
		const schedule: ChannelSchedule = {
			...input([baseProgram], [baseMedia], base).schedule,
			layers: [{
				id: layerId,
				templateId: overlay.id,
				predicate: {
					type: 'time-range',
					startSeconds: 0,
					endSeconds: 3 * 3_600,
					negated: false,
				},
				entryBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'reject-start' },
				exitBoundary: {
					policy: 'finish-left',
					maxDriftSeconds: 90 * 60,
					fallback: 'favor-right',
					earlyStartMaxDriftSeconds: 75 * 60,
				},
			}],
		};

		const result = generateTimeline(input(
			[baseProgram, overlayProgram],
			[first, tooLong, baseMedia],
			base,
			{ schedule, templates: [base, overlay] },
		));
		const firstBaseSegment = result.segments.find((segment) =>
			segment.programId === baseProgram.id && segment.role === 'primary');

		expect(firstBaseSegment?.start).toBe('2026-01-05T02:00:00Z');
		expect(result.segments.some((segment) =>
			segment.role === 'dead-air'
			&& segment.start === '2026-01-05T02:00:00Z'
			&& segment.finish === '2026-01-05T03:00:00Z')).toBe(false);
		expect(result.proposedState.find((record) => record.consumerKey.includes(overlayProgram.id))?.value)
			.toMatchObject({ type: 'sequential', lastItemId: first.id });
	});

	it('starts an ordinary incoming slot early after a finish-left attempt cannot fit', () => {
		const first = media(1, 2 * 3_600);
		const tooLong = media(2, 4 * 3_600);
		const incoming = media(3, 60 * 60);
		const outgoingProgram = contentProgram(10, [1, 2]);
		const incomingProgram = contentProgram(11, 3);
		const daily = template([
			{
				programId: outgoingProgram.id,
				startSeconds: 0,
				startEligibility: { type: 'allow-overrun' },
				boundary: {
					policy: 'finish-left',
					maxDriftSeconds: 90 * 60,
					fallback: 'favor-right',
					earlyStartMaxDriftSeconds: 75 * 60,
				},
			},
			{ programId: incomingProgram.id, startSeconds: 3 * 3_600 },
		]);

		const result = generateTimeline(input(
			[outgoingProgram, incomingProgram],
			[first, tooLong, incoming],
			daily,
		));
		const incomingSegment = result.segments.find((segment) =>
			segment.programId === incomingProgram.id && segment.role === 'primary');
		expect(incomingSegment?.start).toBe('2026-01-05T02:00:00Z');
		expect(result.proposedState.find((record) => record.consumerKey.includes(outgoingProgram.id))?.value)
			.toMatchObject({ type: 'sequential', lastItemId: first.id });
	});

	it('retains dead air and an occurrence when the early fallback limit is exceeded', () => {
		const first = media(1, 2 * 3_600);
		const tooLong = media(2, 4 * 3_600);
		const overlayMedia = media(3, 60 * 60);
		const baseProgram = contentProgram(10, [1, 2]);
		const overlayProgram = contentProgram(11, 3);
		const base = template([{ programId: baseProgram.id, startSeconds: 0 }]);
		const overlay = template([{ programId: overlayProgram.id, startSeconds: 0 }], null, 101);
		const layerId = uuid(600);
		const schedule: ChannelSchedule = {
			...input([baseProgram], [first, tooLong], base).schedule,
			layers: [{
				id: layerId,
				templateId: overlay.id,
				predicate: {
					type: 'time-range',
					startSeconds: 3 * 3_600,
					endSeconds: 23 * 3_600,
					negated: false,
				},
				entryBoundary: {
					policy: 'finish-left',
					maxDriftSeconds: 90 * 60,
					fallback: 'favor-right',
					earlyStartMaxDriftSeconds: 30 * 60,
				},
				exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'reject-start' },
			}],
		};

		const result = generateTimeline(input(
			[baseProgram, overlayProgram],
			[first, tooLong, overlayMedia],
			base,
			{ schedule, templates: [base, overlay] },
		));
		expect(result.segments.find((segment) => segment.role === 'dead-air')).toMatchObject({
			start: '2026-01-05T02:00:00Z',
			finish: '2026-01-05T03:00:00Z',
		});
		expect(result.issues.find((issue) => issue.code === 'boundary-start-rejected'))
			.toMatchObject({
				scheduleLayerId: layerId,
				occurrenceCount: 1,
				occurrences: [{
					start: '2026-01-05T02:00:00Z',
					finish: '2026-01-05T03:00:00Z',
					boundaryOrigin: 'layer-entry',
				}],
			});
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
				sort: { type: 'date-added', direction: 'asc' },
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
				sort: { type: 'date-added', direction: 'asc' },
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
		expect(result.issues.find((issue) => issue.code === 'source-reference-missing')?.message)
			.toBe('1 selected item is no longer indexed.');
		expect(result.proposedState.length).toBeGreaterThan(0);
	});

	it('uses the selected-media sort for sequential collection playback', () => {
		const oldestAdded = media(1, 60 * 60, {
			title: 'Zulu',
			sortTitle: 'Zulu',
			year: null,
			releaseDate: null,
		});
		const middleAdded = media(2, 60 * 60, {
			title: 'Alpha Later',
			sortTitle: 'Alpha',
			year: 2001,
			releaseDate: '2001-06-01',
		});
		const newestAdded = media(3, 60 * 60, {
			title: 'Alpha Earlier',
			sortTitle: 'Alpha',
			year: 2001,
			releaseDate: null,
		});
		const items = [oldestAdded, middleAdded, newestAdded];
		const orderedTitles = (sort: SelectedMediaSort): string[] => {
			const collection = program(10, {
				type: 'content',
				source: {
					type: 'collection',
					libraryId: uuid(900),
					itemIds: items.map((item) => item.id),
					additionBatches: [[oldestAdded.id], [middleAdded.id, newestAdded.id]],
					sort,
				},
				strategy: { type: 'sequential' },
			});
			const daily = template([{ programId: collection.id, startSeconds: 0 }]);
			return primaryTitles(generateTimeline(input([collection], items, daily))).slice(0, 3);
		};

		expect(orderedTitles({ type: 'date-added', direction: 'asc' }))
			.toEqual(['Zulu', 'Alpha Later', 'Alpha Earlier']);
		expect(orderedTitles({ type: 'date-added', direction: 'desc' }))
			.toEqual(['Alpha Later', 'Alpha Earlier', 'Zulu']);
		expect(orderedTitles({ type: 'name', direction: 'asc' }))
			.toEqual(['Alpha Later', 'Alpha Earlier', 'Zulu']);
		expect(orderedTitles({ type: 'release-date', direction: 'desc' }))
			.toEqual(['Alpha Later', 'Alpha Earlier', 'Zulu']);
		expect(orderedTitles({
			type: 'manual',
			itemIds: [newestAdded.id, oldestAdded.id, middleAdded.id],
		})).toEqual(['Alpha Earlier', 'Zulu', 'Alpha Later']);
	});

	it('preserves a legacy sequential collection cursor after adding the default sort', () => {
		const items = [media(1, 60 * 60), media(2, 60 * 60), media(3, 60 * 60)];
		const collection = program(10, {
			type: 'content',
			source: {
				type: 'collection',
				libraryId: uuid(900),
				itemIds: items.map((item) => item.id),
				sort: { type: 'date-added', direction: 'asc' },
			},
			strategy: { type: 'sequential' },
		});
		const daily = template([{ programId: collection.id, startSeconds: 0 }]);
		const first = generateTimeline(input([collection], items, daily));
		const currentState = first.proposedState[0]!;
		const legacyConfig = {
			type: 'content',
			source: {
				type: 'collection',
				libraryId: uuid(900),
				itemIds: items.map((item) => item.id),
			},
			strategy: { type: 'sequential' },
		};
		const legacyState: SelectionStateRecord = {
			...currentState,
			configFingerprint: stableJsonFingerprint(legacyConfig),
			value: { type: 'sequential', nextIndex: 1, lastItemId: items[0]!.id },
		};

		const continued = generateTimeline(input([collection], items, daily, { state: [legacyState] }));

		expect(primaryTitles(continued)[0]).toBe(items[1]!.title);
	});

	it('migrates legacy set-strategy fingerprints without resetting their state', () => {
		const items = [
			media(1, SECONDS_PER_SCHEDULING_DAY),
			media(2, SECONDS_PER_SCHEDULING_DAY),
			media(3, SECONDS_PER_SCHEDULING_DAY),
		];
		const itemIds = [items[2]!.id, items[0]!.id, items[1]!.id];
		const daily = template([{ programId: uuid(10), startSeconds: 0 }]);

		for (const strategyType of ['random', 'weighted-random'] as const) {
			const strategy = { type: strategyType, seed: 'fixture' };
			const collection = program(10, {
				type: 'content',
				source: {
					type: 'collection',
					libraryId: uuid(900),
					itemIds,
					sort: { type: 'date-added', direction: 'asc' },
				},
				strategy,
			});
			const initialized = generateTimeline(input([collection], items, daily));
			const legacyConfig = {
				type: 'content',
				source: { type: 'collection', libraryId: uuid(900), itemIds },
				strategy,
			};
			const legacyFingerprint = stableJsonFingerprint(legacyConfig);
			const legacyState: SelectionStateRecord = {
				...initialized.proposedState[0]!,
				configFingerprint: legacyFingerprint,
				value: { type: strategyType, counter: 17, lastItemId: items[0]!.id },
			};

			const continued = generateTimeline(input([collection], items, daily, {
				state: [legacyState],
			}));
			const migrated = continued.proposedState[0]!;

			expect(migrated.value).toMatchObject({ type: strategyType, counter: 18 });
			expect(migrated.configFingerprint).not.toBe(legacyFingerprint);
		}

		const shuffleStrategy = { type: 'shuffle' as const, seed: 'fixture' };
		const shuffled = program(10, {
			type: 'content',
			source: {
				type: 'collection',
				libraryId: uuid(900),
				itemIds,
				sort: { type: 'date-added', direction: 'asc' },
			},
			strategy: shuffleStrategy,
		});
		const initialized = generateTimeline(input([shuffled], items, daily));
		const legacyFingerprint = stableJsonFingerprint({
			type: 'content',
			source: { type: 'collection', libraryId: uuid(900), itemIds },
			strategy: shuffleStrategy,
		});
		const legacyState: SelectionStateRecord = {
			...initialized.proposedState[0]!,
			configFingerprint: legacyFingerprint,
			value: {
				type: 'shuffle',
				cycle: 7,
				cycleItemIds: itemIds,
				remainingItemIds: itemIds.slice(1),
				lastItemId: itemIds[0]!,
			},
		};

		const continued = generateTimeline(input([shuffled], items, daily, { state: [legacyState] }));
		const migrated = continued.proposedState[0]!;

		expect(migrated.value).toMatchObject({ type: 'shuffle', cycle: 7 });
		expect(migrated.configFingerprint).not.toBe(legacyFingerprint);
	});

	it('uses available members without dropping temporarily unavailable collection members', () => {
		const firstUnavailable = media(1, 60 * 60, { availability: 'unconfirmed' });
		const available = media(2, 60 * 60);
		const secondUnavailable = media(3, 60 * 60, { availability: 'unconfirmed' });
		const collection = program(10, {
			type: 'content',
			source: {
				type: 'collection',
				libraryId: uuid(900),
				itemIds: [firstUnavailable.id, available.id, secondUnavailable.id],
				sort: { type: 'date-added', direction: 'asc' },
			},
			strategy: { type: 'sequential' },
		});
		const daily = template([{ programId: collection.id, startSeconds: 0 }]);

		const result = generateTimeline(input(
			[collection],
			[firstUnavailable, available, secondUnavailable],
			daily,
		));

		expect(
			result.segments
				.filter((segment) => segment.role === 'primary')
				.every((segment) => segment.mediaItemId === available.id),
		).toBe(true);
		expect(result.issues.find((issue) => issue.code === 'source-unavailable')?.message)
			.toBe('2 indexed items are temporarily unavailable.');
	});

	it('uses dead air without advancing state when an indexed source is temporarily unavailable', () => {
		const unavailable = media(1, 30 * 60, { availability: 'unconfirmed' });
		const movies = contentProgram(10, 1);
		const daily = template([{ programId: movies.id, startSeconds: 0 }]);

		const result = generateTimeline(input([movies], [unavailable], daily));

		expect(result.segments.every((segment) => segment.role === 'dead-air')).toBe(true);
		expect(result.issues.find((issue) => issue.code === 'source-unavailable')?.message)
			.toBe('1 indexed item is temporarily unavailable.');
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
