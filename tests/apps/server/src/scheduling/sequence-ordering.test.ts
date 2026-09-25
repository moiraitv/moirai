import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '@server/db/index.js';
import { schedulingPrograms, selectionStates } from '@server/db/schema.js';
import { Repository } from '@server/repository/index.js';
import { channelCreateSchema } from '@moirai/shared';
import { describe, expect, it } from 'vitest';
import type {
	ChannelSchedule,
	ProgramConfig,
	ScheduleBoundary,
	ScheduleSlot,
	ScheduleTemplate,
	SchedulableMedia,
	SchedulingProgram,
} from '@moirai/shared';
import {
	SECONDS_PER_SCHEDULING_DAY,
} from '@moirai/shared';
import {
	generateTimeline,
	generateTimelineDetailed,
	type GenerateTimelineInput,
} from '@server/scheduling/engine.js';
import { stableJsonFingerprint } from '@server/stable-json.js';
import { programConfigSchema, type SequenceOrdering } from '@moirai/shared';

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

function fixture(ordering?: SequenceOrdering, repeat = true, counts = [3, 2, 1]) {
	const children = counts.map((_, index) => contentProgram(10 + index, index + 1));
	const sequence = program(2000, { type: 'sequence', entries: children.map((child, index) => ({ id: uuid(400 + index), programId: child.id, count: counts[index]! })), repeat, ...(ordering ? { ordering } : {}) });
	return input([...children, sequence], counts.map((_, index) => media(index + 1, 3600)), template([{ programId: sequence.id, startSeconds: 0 }]));
}

const modes: SequenceOrdering[] = [{ type: 'ordered' }, { type: 'shuffled-blocks', seed: 'test' }, { type: 'shuffled-allocations', seed: 'test' }, { type: 'balanced-rotation' }];

describe('sequence ordering', () => {
	it.each(modes)('honors unequal quotas and completes one finite $type cycle', (ordering) => {
		const result = generateTimelineDetailed(fixture(ordering, false));
		const titles = primaryTitles(result);
		expect(titles).toHaveLength(6);
		expect(titles.filter((title) => title === 'Item 1')).toHaveLength(3);
		expect(titles.filter((title) => title === 'Item 2')).toHaveLength(2);
		expect(titles.filter((title) => title === 'Item 3')).toHaveLength(1);
		expect(result.proposedState.find((record) => record.value.type === 'sequence')?.value).toMatchObject({ completed: true });
	});

	it('keeps shuffled blocks together', () => {
		const titles = primaryTitles(generateTimelineDetailed(fixture(modes[1], false)));
		const runs = titles.filter((title, index) => index === 0 || title !== titles[index - 1]);
		expect(runs).toHaveLength(3);
		expect(new Set(runs).size).toBe(3);
	});

	it('balances proportional deficits with authored tie breaks', () => {
		expect(primaryTitles(generateTimelineDetailed(fixture(modes[3], false)))).toEqual(['Item 1', 'Item 2', 'Item 1', 'Item 3', 'Item 2', 'Item 1']);
	});

	it.each(modes)('resumes serialized $type progress identically to uninterrupted generation', (ordering) => {
		const initial = fixture(ordering, true, [7, 4, 2]);
		const first = generateTimelineDetailed(initial);
		const continued = generateTimelineDetailed({ ...initial, startDate: '2026-01-06', state: JSON.parse(JSON.stringify(first.proposedState)) });
		const full = generateTimelineDetailed({ ...initial, days: 2 });
		expect([...first.segments, ...continued.segments]).toEqual(full.segments);
	});

	it('preserves legacy Ordered fingerprints and partially consumed cursors', () => {
		const initial = fixture(undefined, true, [10, 10, 10]);
		const first = generateTimelineDetailed(initial);
		const parent = first.proposedState.find((record) => record.value.type === 'sequence')!;
		expect(parent.configFingerprint).toBe(stableJsonFingerprint(initial.programs.at(-1)!.config));
		const parsed = initial.programs.map((item) => ({ ...item, config: programConfigSchema.parse(item.config.type === 'sequence' ? { ...item.config, ordering: { type: 'ordered' } } : item.config) }));
		const options = { ...initial, startDate: '2026-01-06', state: JSON.parse(JSON.stringify(first.proposedState)) };
		expect(generateTimelineDetailed({ ...options, programs: parsed }).segments).toEqual(generateTimelineDetailed(options).segments);
	});

	it.each(modes)('handles a single entry in $type', (ordering) => {
		expect(primaryTitles(generateTimelineDetailed(fixture(ordering, false, [3])))).toEqual(['Item 1', 'Item 1', 'Item 1']);
	});

	it.each(modes.slice(1))('keeps maximum quotas compact for $type', (ordering) => {
		const result = generateTimelineDetailed(fixture(ordering, true, Array.from({ length: 100 }, () => 10000)));
		const parent = result.proposedState.find((record) => record.value.type === 'sequence')!;
		expect(JSON.stringify(parent).length).toBeLessThan(3000);
	});

	it.each(modes.slice(1, 3))('uses generation randomness unless an explicit seed is set for $type', (ordering) => {
		const initial = fixture(ordering);
		const first = generateTimelineDetailed(initial);
		expect(generateTimelineDetailed({ ...initial, schedule: { ...initial.schedule, generationSeed: uuid(800) } }).segments).toEqual(first.segments);
		const unseeded = fixture({ ...ordering, seed: '' } as SequenceOrdering);
		const a = generateTimelineDetailed({ ...unseeded, schedule: { ...unseeded.schedule, generationSeed: uuid(800) } });
		const b = generateTimelineDetailed({ ...unseeded, schedule: { ...unseeded.schedule, generationSeed: uuid(801) } });
		expect(primaryTitles(a)).not.toEqual(primaryTitles(b));
	});
});

it.each(modes)('loads saved $type configuration and progress after a database restart', async (ordering) => {
	const directory = await mkdtemp(path.join(tmpdir(), 'moirai-sequence-'));
	const databasePath = path.join(directory, 'test.sqlite');
	let database = createDatabase(databasePath, path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ name: 'Sequence', number: '1' }));
		const initial = fixture(ordering.type === 'ordered' ? undefined : ordering, true, [10, 10, 10]);
		initial.channelId = channel.id;
		initial.schedule.channelId = channel.id;
		const first = generateTimelineDetailed(initial);
		await database.db.insert(schedulingPrograms).values(initial.programs.map((item) => ({ ...item, nameKey: item.name.toLowerCase() })));
		await database.db.insert(selectionStates).values(first.proposedState.map((record) => ({ ...record, channelId: channel.id })));
		database.close();
		database = createDatabase(databasePath, path.resolve('drizzle'));
		const reopened = new Repository(database.db);
		const programs = await Promise.all(initial.programs.map(async (item) => (await reopened.getProgram(item.id))!));
		const state = await reopened.getSelectionState(channel.id);
		const options = { ...initial, startDate: '2026-01-06' };
		expect(generateTimelineDetailed({ ...options, programs, state }).segments)
			.toEqual(generateTimelineDetailed({ ...options, state: first.proposedState }).segments);
	}
	finally {
		database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

it.each(modes.slice(1))('continues other entries after a finite nested child exhausts in $type', (ordering) => {
	const initial = fixture(ordering, true, [3, 2, 1]);
	const leaf = initial.programs[0]!;
	initial.programs.push(program(30, { type: 'sequence', repeat: false, entries: [{ id: uuid(600), programId: leaf.id, count: 1 }] }));
	const parent = initial.programs.find((item) => item.id === uuid(2000))!;
	if (parent.config.type === 'sequence') {
		parent.config.entries[0]!.programId = uuid(30);
	}
	const titles = primaryTitles(generateTimelineDetailed(initial));
	expect(titles).toHaveLength(24);
	expect(titles.filter((title) => title === 'Item 1')).toHaveLength(1);
});

it.each(modes)('preserves state on fully blocked $type selections', (ordering) => {
	const initial = fixture(ordering);
	const first = generateTimelineDetailed(initial);
	const state = structuredClone(first.proposedState);
	const result = generateTimelineDetailed({ ...initial, startDate: '2026-01-06', state,
		catalog: { ...initial.catalog, media: initial.catalog.media.map((item) => ({ ...item, availability: 'unconfirmed' })) },
	});
	expect(result.proposedState).toEqual(state);
	expect(primaryTitles(result)).toHaveLength(0);
});

it.each(modes.slice(1))('does not consume $type progress on a rejected duration fit', (ordering) => {
	const initial = fixture(ordering);
	const first = generateTimelineDetailed(initial);
	const state = structuredClone(first.proposedState);
	const daily = template([{ programId: uuid(2000), startSeconds: 0 }, { programId: null, startSeconds: 30 }]);
	const result = generateTimelineDetailed({ ...initial, template: daily, startDate: '2026-01-06', state });
	expect(primaryTitles(result)).toHaveLength(0);
	expect(result.proposedState).toEqual(state);
});

it('keeps episode cursors when changing the parent mode and preserves progress for presentation edits', () => {
	const initial = fixture(undefined, true, [30]);
	initial.programs[0] = contentProgram(10, [1, 2]);
	initial.catalog.media = Array.from({ length: 50 }, (_, index) => media(index + 1, 3600));
	const first = generateTimelineDetailed(initial);
	const parent = initial.programs[1]!;
	if (parent.config.type !== 'sequence') {
		throw new Error('Expected sequence fixture');
	}
	parent.config.ordering = { type: 'balanced-rotation' };
	const continued = generateTimelineDetailed({ ...initial, startDate: '2026-01-06', state: first.proposedState });
	expect(primaryTitles(continued)[0]).toBe('Item 25');
	parent.config.audioPreferences = { language: 'en' };
	const presentationOnly = generateTimelineDetailed({ ...initial, startDate: '2026-01-06', state: first.proposedState });
	expect(primaryTitles(presentationOnly)).toEqual(primaryTitles(continued));
});

it('avoids consecutive balanced entries across cycle boundaries when quotas permit', () => {
	const titles = primaryTitles(generateTimelineDetailed(fixture({ type: 'balanced-rotation' })));
	expect(titles).toHaveLength(24);
	expect(titles.every((title, index) => index === 0 || title !== titles[index - 1])).toBe(true);
});

it.each(modes)('keeps duplicate child references independent in $type', (ordering) => {
	const initial = fixture(ordering, false, [2, 2]);
	initial.programs[0] = contentProgram(10, [1, 2]);
	const parent = initial.programs.at(-1)!;
	if (parent.config.type === 'sequence') {
		parent.config.entries[1]!.programId = initial.programs[0]!.id;
	}
	const titles = primaryTitles(generateTimelineDetailed(initial));
	expect(titles.filter((title) => title === 'Item 1')).toHaveLength(2);
	expect(titles.filter((title) => title === 'Item 2')).toHaveLength(2);
});

it.each(modes)('restarts daily $type slots while persistent finite cycles stay completed', (ordering) => {
	const initial = fixture(ordering, false);
	const first = generateTimelineDetailed(initial);
	const persistent = generateTimelineDetailed({ ...initial, startDate: '2026-01-06', state: first.proposedState });
	expect(primaryTitles(persistent)).toHaveLength(0);
	initial.template.slots[0]!.stateScope = 'occurrence';
	const daily = generateTimelineDetailed({ ...initial, days: 2 });
	expect(primaryTitles(daily)).toHaveLength(12);
});

it('validates sequence ordering and seed input without changing legacy defaults', () => {
	const config = fixture().programs.at(-1)!.config;
	expect(programConfigSchema.parse(config)).toEqual(config);
	expect(programConfigSchema.safeParse({ ...config, ordering: { type: 'random' } }).success).toBe(false);
	const parsed = programConfigSchema.parse({ ...config, ordering: { type: 'shuffled-blocks', seed: ' demo ' } });
	expect(parsed).toMatchObject({ ordering: { type: 'shuffled-blocks', seed: 'demo' } });
});

it.each(['best-fit-only', 'best-fit-or-truncate'] as const)('preserves shuffled blocks across $0 filler windows', (policy) => {
	const initial = fixture({ type: 'shuffled-blocks', seed: '0' }, false, [2, 2]);
	initial.catalog.media[0]!.durationSeconds = 60;
	initial.catalog.media[1]!.durationSeconds = 30;
	initial.catalog.media.push(media(99, 1000));
	initial.programs.push(contentProgram(99, 99));
	initial.template = template([{ programId: uuid(99), startSeconds: 0 }, { programId: null, startSeconds: 90 }], { programId: uuid(2000), policy });
	const result = generateTimelineDetailed({ ...initial, days: 3 });
	const filler = result.segments.filter((segment) => segment.role === 'filler');
	expect(filler.map((segment) => segment.title)).toEqual(['Item 1', 'Item 1', 'Item 2', 'Item 2']);
	expect(filler[1]!.truncated).toBe(policy === 'best-fit-or-truncate');
	expect(filler[1]!.start).toBe(policy === 'best-fit-only' ? '2026-01-06T00:00:00Z' : '2026-01-05T00:01:00Z');
});

it('preserves a stored legacy preference-bearing cursor after saving explicit Ordered', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'moirai-sequence-legacy-'));
	const database = createDatabase(path.join(directory, 'test.sqlite'), path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ name: 'Legacy', number: '1' }));
		const initial = fixture(undefined, true, [10, 10, 10]);
		initial.channelId = channel.id;
		initial.schedule.channelId = channel.id;
		const parent = initial.programs.at(-1)!;
		parent.config.audioPreferences = { language: 'en' };
		const first = generateTimelineDetailed(initial);
		const legacyState = structuredClone(first.proposedState);
		legacyState.find((record) => record.value.type === 'sequence')!.configFingerprint = stableJsonFingerprint(parent.config);
		await database.db.insert(schedulingPrograms).values(initial.programs.map((item) => ({ ...item, nameKey: item.name.toLowerCase() })));
		await database.db.insert(selectionStates).values(legacyState.map((record) => ({ ...record, channelId: channel.id })));
		await repository.updateProgram(parent.id, { name: parent.name, config: programConfigSchema.parse({ ...parent.config, ordering: { type: 'ordered' } }) });
		const programs = await Promise.all(initial.programs.map(async (item) => (await repository.getProgram(item.id))!));
		const state = await repository.getSelectionState(channel.id);
		const options = { ...initial, startDate: '2026-01-06' };
		const resumed = generateTimelineDetailed({ ...options, programs, state });
		const expected = generateTimelineDetailed({ ...options, state: first.proposedState });
		expect(resumed.segments).toEqual(expected.segments);
		expect(resumed.proposedState).toEqual(expected.proposedState);
	}
	finally {
		database.close();
		await rm(directory, { recursive: true, force: true });
	}
});
