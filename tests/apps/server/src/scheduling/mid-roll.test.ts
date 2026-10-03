import { planFiller } from '@server/scheduling/filler-plan.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { channelCreateSchema } from '@moirai/shared';
import { MediaProbe } from '@server/media/media-probe.js';
import { buildEtvPlayoutFiles } from '@server/playback/playout-output.js';
import { describe, expect, it } from 'vitest';
import { BUILTIN_MID_ROLL_PRESETS, defaultMidRollConfig, MAX_MID_ROLL_POINTS, SECONDS_PER_SCHEDULING_DAY, type MidRollSettings, type ChannelSchedule, type ProgramConfig,
	type ScheduleBoundary, type ScheduleSlot, type ScheduleTemplate, type SchedulableMedia,
	type SchedulingProgram } from '@moirai/shared';
import { TimelineMaterializationLimitError, generateTimelineDetailed, type GenerateTimelineInput } from '@server/scheduling/engine.js';
import { projectGuideEntries } from '@server/guide/projection.js';

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


function fixture(seconds = 1_300): GenerateTimelineInput {
	const primary = contentProgram(10, 1);
	const filler = contentProgram(11, 2);
	const daily = template([{ programId: primary.id, startSeconds: 0 },
		{ programId: null, startSeconds: seconds, filler: { mode: 'disabled' } }]);
	daily.defaultMidRoll = defaultMidRollConfig(filler.id);
	const options = input([primary, filler], [media(1, 1_200), media(2, 30)], daily);
	options.catalog.midRollPresets = { [daily.defaultMidRoll.presetId]: { fallbackIntervalSeconds: 600,
		predicate: { type: 'always', negated: false }, budget: { type: 'count', count: 1 } } };
	return options;
}

function settings(options: GenerateTimelineInput): MidRollSettings {
	return options.catalog.midRollPresets![defaultMidRollConfig(uuid(11)).presetId]!;
}

function primaryAiring(options: GenerateTimelineInput) {
	const result = generateTimelineDetailed(options);
	const first = result.segments.find(segment => segment.role === 'primary');
	return { result, spans: result.segments.filter(segment => segment.airing?.id === first?.airing?.id && segment.role !== 'dead-air') };
}

describe('mid-roll airing expansion', () => {
	it('continues sequential default breaks without skipping or truncating the next item', () => {
		const options = fixture(2_600);
		options.catalog.media = [media(1, 1_800), media(2, 70), media(3, 60), media(4, 100)];
		options.programs[1]!.config = { type: 'content', source: { type: 'collection', libraryId: uuid(900),
			itemIds: [uuid(2), uuid(3), uuid(4)], sort: { type: 'name', direction: 'asc' } }, strategy: { type: 'sequential' } };
		const assignment = defaultMidRollConfig(uuid(11));
		options.catalog.midRollPresets = { [assignment.presetId]: BUILTIN_MID_ROLL_PRESETS.find(preset => preset.id === assignment.presetId)! };

		const { spans } = primaryAiring(options);
		const filler = spans.filter(span => span.role === 'filler');
		expect(filler.map(span => span.mediaItemId)).toEqual([uuid(2), uuid(3)]);
		expect(filler.map(span => (Date.parse(span.finish) - Date.parse(span.start)) / 1_000)).toEqual([70, 60]);
		expect(filler.every(span => !span.truncated)).toBe(true);
		expect(filler.every(span => span.fillerStage === 'mid-roll')).toBe(true);
	});
	it('keeps expansion bounded with large primary and filler pools and future channel occupancy', () => {
		const options = fixture(1_230);
		const primaryIds = [uuid(1)];
		const fillerIds = [uuid(2)];
		let unusedPlans = 0;
		for (let index = 3; index < 1_002; index += 1) {
			const item = media(index, index < 902 ? 1_200 : 30);
			if (index < 902) {
				primaryIds.push(item.id);
				Object.defineProperty(item, 'chapters', { get: () => {
					unusedPlans += 1;
					return [];
				} });
			}
			else {
				fillerIds.push(item.id);
			}
			options.catalog.media.push(item);
		}
		for (const [index, itemIds] of [primaryIds, fillerIds].entries()) {
			options.programs[index]!.config = { type: 'content', source: { type: 'collection', libraryId: uuid(900), itemIds,
				sort: { type: 'name', direction: 'asc' } }, strategy: { type: 'sequential' } };
		}
		settings(options).budget = { type: 'duration', seconds: 30, policy: 'best-fit-only' };
		options.occupiedMedia = options.catalog.media.map(item => ({ mediaItemId: item.id,
			start: '2026-01-06T00:00:00Z', finish: '2026-01-07T00:00:00Z' }));

		const { spans } = primaryAiring(options);
		expect(spans.map(span => span.role)).toEqual(['primary', 'filler', 'primary']);
		expect(spans[1]?.mediaItemId).toBe(uuid(2));
		expect(unusedPlans).toBe(0);
	});
	it('indexes unrelated channel occupancy once across primary and filler candidate selection', () => {
		const options = fixture(1_230);
		let intervalReads = 0;
		options.occupiedMedia = Array.from({ length: 2_000 }, (_, index) => ({
			get mediaItemId() {
				intervalReads += 1;
				return uuid(10_000 + index);
			},
			start: '2026-01-05T00:00:00Z',
			finish: '2026-01-06T00:00:00Z',
		}));

		const { spans } = primaryAiring(options);
		expect(spans.map(span => span.role)).toEqual(['primary', 'filler', 'primary']);
		expect(intervalReads).toBe(options.occupiedMedia.length);
	});
	it.each(['empty', 'unrelated', 'expired'] as const)('does not plan unused candidates for %s occupancy', (occupancy) => {
		const options = fixture(1_230);
		options.programs[0]!.config = { type: 'content',
			source: { type: 'collection', libraryId: uuid(900), itemIds: [uuid(1), uuid(3)], sort: { type: 'name', direction: 'asc' } },
			strategy: { type: 'sequential' } };
		let unusedPlans = 0;
		const unused = media(3, 1_200);
		Object.defineProperty(unused, 'chapters', { get: () => {
			unusedPlans += 1;
			return [];
		} });
		options.catalog.media.push(unused);
		options.occupiedMedia = occupancy === 'empty' ? [] : [{
			mediaItemId: occupancy === 'unrelated' ? uuid(2) : uuid(3),
			start: '2026-01-04T23:00:00Z',
			finish: occupancy === 'expired' ? '2026-01-05T00:00:00Z' : '2026-01-05T01:00:00Z',
		}];

		const { spans } = primaryAiring(options);
		expect(spans.map(span => span.role)).toEqual(['primary', 'filler', 'primary']);
		expect(unusedPlans).toBe(0);
	});
	it('bounds speculative expansion before excessive tiny filler can exhaust resources', () => {
		const options = fixture();
		settings(options).budget = { type: 'duration', seconds: 86_400, policy: 'next-truncate' };
		options.catalog.media[1]!.durationSeconds = 1;
		expect(() => generateTimelineDetailed(options)).toThrow(TimelineMaterializationLimitError);
	});

	it('inserts count filler at timed points and resumes without dropping or replaying content', () => {
		const { result, spans } = primaryAiring(fixture());
		expect(spans.map(span => span.role)).toEqual(['primary', 'filler', 'primary']);
		expect(spans.map(span => [span.sourceStartSeconds, span.sourceFinishSeconds])).toEqual([[0, 600], [0, 30], [600, 1_200]]);
		expect(spans.at(-1)?.finish).toBe('2026-01-05T00:20:30Z');
		expect(new Set(spans.map(span => span.airing?.id)).size).toBe(1);
		expect(result.proposedState.filter(record => record.consumerKey.startsWith('primary:'))).toHaveLength(1);
		expect(result.proposedState.filter(record => record.consumerKey.startsWith('mid-roll:'))).toHaveLength(1);
		expect(result.stateTransitions.find(entry => entry.segmentId === spans[1]?.id)?.continuation?.phase).toBe('primary');
	});

	it('uses chapter points and titles instead of timed fallback', () => {
		const options = fixture();
		options.catalog.media[0]!.chapters = [{ startSeconds: 0, finishSeconds: 300.125, title: 'Act 1' },
			{ startSeconds: 300.125, finishSeconds: 900, title: 'Credits' }];
		settings(options).predicate = { type: 'title', value: 'Credits', negated: true };
		const { spans } = primaryAiring(options);
		expect(spans.map(span => span.sourceStartSeconds)).toEqual([0, 0, 300.125]);
		expect(spans[0]?.sourceFinishSeconds).toBe(300.125);
	});

	it('does not enable timed fallback when all chapter points are rejected', () => {
		const options = fixture();
		options.catalog.media[0]!.chapters = [{ startSeconds: 0, finishSeconds: 300, title: 'Credits' }];
		settings(options).predicate = { type: 'title', value: 'Credits', negated: true };
		const result = generateTimelineDetailed(options);
		expect(result.segments.filter(span => span.role === 'primary')).toHaveLength(1);
		expect(result.segments.some(span => span.role === 'filler')).toBe(false);
	});

	it.each(['next-truncate', 'best-fit-or-truncate'] as const)('fills and clips a duration break with %s', policy => {
		const options = fixture(1_350);
		settings(options).budget = { type: 'duration', seconds: 45, policy };
		const { spans } = primaryAiring(options);
		expect(spans.map(span => span.role)).toEqual(['primary', 'filler', 'filler', 'primary']);
		expect(spans[2]).toMatchObject({ sourceFinishSeconds: 15, truncated: true });
		expect(spans[0]?.airing?.truncated).toBe(false);
	});

	it.each(['next-fit-only', 'best-fit-only'] as const)('resumes immediately after a partial %s break', policy => {
		const options = fixture();
		settings(options).budget = { type: 'duration', seconds: 45, policy };
		const { result, spans } = primaryAiring(options);
		expect(spans.at(-1)?.finish).toBe('2026-01-05T00:20:30Z');
		expect(result.issues.some(issue => issue.code === 'mid-roll-shortfall')).toBe(true);
	});

	it('records each mid-roll shortfall at its own break', () => {
		const options = fixture(2_000);
		options.catalog.media[0]!.durationSeconds = 1_800;
		settings(options).budget = { type: 'duration', seconds: 45, policy: 'next-fit-only' };
		const issue = primaryAiring(options).result.issues.find(entry => entry.code === 'mid-roll-shortfall');
		expect(issue?.occurrenceCount).toBe(2);
		expect(issue?.occurrences?.map(entry => entry.start)).toEqual([
			'2026-01-05T00:10:00.000Z',
			'2026-01-05T00:20:30.000Z',
		]);
	});

	it('warns when stored chapters exceed the retained break points', () => {
		const options = fixture(MAX_MID_ROLL_POINTS + 30);
		const duration = MAX_MID_ROLL_POINTS + 2;
		options.catalog.media[0]!.durationSeconds = duration;
		options.catalog.media[0]!.chapterLimitExceeded = false;
		options.catalog.media[0]!.chapters = Array.from({ length: MAX_MID_ROLL_POINTS + 1 }, (_, index) => ({
			startSeconds: index, finishSeconds: index + 1, title: '',
		}));
		settings(options).predicate = { type: 'always', negated: true };
		expect(generateTimelineDetailed(options).issues.some(entry => entry.code === 'mid-roll-points-limited')).toBe(true);
	});

	it('rejects an expanded item without consuming either cursor', () => {
		const result = generateTimelineDetailed(fixture(1_210));
		expect(result.segments.some(span => span.role === 'primary' || span.role === 'filler')).toBe(false);
		expect(result.proposedState).toEqual([]);
	});

	it.each([610, 1_210])('applies hard truncation at %i seconds even inside a break', seconds => {
		const options = fixture(seconds);
		options.template.slots[0]!.startEligibility = { type: 'allow-truncate' };
		const { spans } = primaryAiring(options);
		expect(spans.at(-1)?.finish).toBe(new Date(Date.parse('2026-01-05T00:00:00Z') + seconds * 1_000).toISOString().replace('.000Z', 'Z'));
		expect(spans[0]?.airing?.truncated).toBe(true);
		expect(spans.at(-1)?.sourceFinishSeconds).toBe(seconds === 610 ? 10 : 1_180);
		expect(spans.filter(span => span.role === 'filler').every(span => span.fillerStage === 'mid-roll')).toBe(true);
	});

	it('honors slot disable and configured overrides over inherited defaults', () => {
		const options = fixture();
		options.schedule.defaultMidRoll = options.template.defaultMidRoll;
		options.template.defaultMidRoll = null;
		options.template.slots[0]!.midRoll = { mode: 'disabled' };
		expect(generateTimelineDetailed(options).segments.some(span => span.role === 'filler')).toBe(false);
		options.template.slots[0]!.midRoll = { mode: 'configured', config: defaultMidRollConfig(uuid(11)) };
		settings(options).budget = { type: 'count', count: 2 };
		expect(primaryAiring(options).spans.filter(span => span.role === 'filler')).toHaveLength(2);
	});

	it('fills the remaining slot with tail filler after the complete mid-roll airing', () => {
		const options = fixture();
		options.template.slots[0]!.filler = { mode: 'configured', config: { programId: uuid(11), policy: 'next-truncate' } };
		const { result, spans } = primaryAiring(options);
		const tail = result.segments.filter(span => span.role === 'filler' && !span.airing);
		expect(spans.at(-1)?.finish).toBe(tail[0]?.start);
		expect(tail.at(-1)?.finish).toBe('2026-01-05T00:21:40Z');
		expect(tail.map(span => span.sourceFinishSeconds)).toEqual([30, 30, 10]);
	});

	it('projects one guide entry including breaks and retains its primary detail target', () => {
		const options = fixture();
		const { result, spans } = primaryAiring(options);
		const entries = projectGuideEntries(
			options.channelId,
			result.segments,
			result.guideOccurrences,
			[options.template],
			'2026-01-05T00:00:00Z',
			'2026-01-06T00:00:00Z',
		);
		const airing = entries.filter(entry => entry.role === 'primary');
		expect(airing).toHaveLength(1);
		expect(airing[0]).toMatchObject({ start: spans[0]?.start, finish: spans.at(-1)?.finish, segmentId: spans[0]?.id });
	});


});

it('uses real probed chapters and exports resumed playout offsets from generated media', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-mid-roll-media-'));
	const executable = process.env.MOIRAI_TEST_FFMPEG ?? 'ffmpeg';
	const probe = new MediaProbe(path.join(path.dirname(executable), 'ffprobe'), 1, 10_000);
	try {
		const metadata = path.join(root, 'chapters.txt');
		const primary = path.join(root, 'primary.mkv');
		const filler = path.join(root, 'filler.mkv');
		await writeFile(metadata, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1125\ntitle=Act 1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1125\nEND=3200\ntitle=Act 2\n');
		execFileSync(executable, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=40',
			'-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-f', 'ffmetadata', '-i', metadata,
			'-map', '0:v', '-map', '1:a', '-map_chapters', '2', '-t', '3.2', '-c:v', 'libx264', '-preset', 'ultrafast',
			'-c:a', 'aac', primary]);
		execFileSync(executable, ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=64x64:rate=40', '-t', '0.6',
			'-c:v', 'libx264', '-preset', 'ultrafast', filler]);
		await probe.start();
		const facts = await probe.probe(root, primary);
		const fillerFacts = await probe.probe(root, filler);
		expect(facts.chapters?.[0]).toMatchObject({ finishSeconds: 1.125, title: 'Act 1' });
		expect(facts.streams.some(stream => stream.type === 'audio')).toBe(true);
		const options = fixture(10);
		options.catalog.media[0] = media(
			1,
			facts.durationMilliseconds / 1_000,
			{ chapters: facts.chapters ?? [], playbackPath: primary },
		);
		options.catalog.media[1] = media(2, fillerFacts.durationMilliseconds / 1_000, { playbackPath: filler });
		settings(options).predicate = { type: 'number', field: 'num', operator: 'eq', value: 1, negated: false };
		const result = generateTimelineDetailed(options);
		const configured = { ...channelCreateSchema.parse({ number: '1', name: 'Mid-roll' }), id: options.channelId,
			createdAt: options.schedule.createdAt, updatedAt: options.schedule.updatedAt };
		const files = buildEtvPlayoutFiles([configured], { timeZone: 'UTC', startDate: options.startDate, requestedDays: 1,
			days: 1, segmentLimitApplied: false, channels: [{ channelId: options.channelId, preview: result }] });
		const documents = [...files.values()].map(content => JSON.parse(content));
		const airingFinish = result.segments[0]!.airing!.finish;
		const clips = documents.flatMap(document => document.items).filter(item => item.source.path === primary && Date.parse(item.start) < Date.parse(airingFinish));
		expect(clips).toHaveLength(2);
		expect(clips[0].source.out_point_ms).toBe(1_125);
		expect(clips[1].source.in_point_ms).toBe(1_125);
		expect(clips[1].source.out_point_ms).toBe(facts.durationMilliseconds);
		// Decode the resumed source interval through the same FFmpeg seek/duration inputs.
		execFileSync(executable, ['-v', 'error', '-ss', '1.125', '-i', primary, '-t',
			String((facts.durationMilliseconds - 1_125) / 1_000), '-f', 'null', '-']);
	}
	finally {
		await probe.close();
		await rm(root, { recursive: true, force: true });
	}
});

it('groups introductions and closings around each primary item and preserves distinct selection state', () => {
	const options = fixture(1_380);
	options.template.defaultMidRoll = null;
	const preId = uuid(401);
	const postId = uuid(402);
	options.template.defaultPreRoll = { presetId: preId, programId: uuid(11) };
	options.template.defaultPostRoll = { presetId: postId, programId: uuid(11) };
	options.catalog.fillerPresets = { [preId]: { budget: { type: 'count', count: 1 } }, [postId]: { budget: { type: 'count', count: 1 } } };
	const result = generateTimelineDetailed(options);
	const spans = result.segments.slice(0, 3);
	expect(spans.map(span => span.role)).toEqual(['filler', 'primary', 'filler']);
	expect(spans.map(span => span.fillerStage)).toEqual(['pre-roll', undefined, 'post-roll']);
	expect(spans[0]!.airing?.primarySegmentId).toBe(spans[1]!.id);
	expect(new Set(spans.map(span => span.airing?.id)).size).toBe(1);
	expect(result.proposedState.map(record => record.consumerKey)).toEqual(expect.arrayContaining([
		expect.stringMatching(/^pre-roll:/), expect.stringMatching(/^post-roll:/), expect.stringMatching(/^primary:/),
	]));
});
it('counts roll duration when rejecting a primary item that cannot fit', () => {
	const options = fixture(1_220);
	options.template.defaultMidRoll = null;
	options.template.defaultPreRoll = { presetId: uuid(401), programId: uuid(11) };
	options.catalog.fillerPresets = { [uuid(401)]: { budget: { type: 'count', count: 1 } } };
	const result = generateTimelineDetailed(options);
	expect(result.segments.some(segment => segment.role === 'primary')).toBe(false);
	expect(result.proposedState.some(record => record.consumerKey.startsWith('pre-roll:'))).toBe(false);
});
it('runs a bounded whole-item tail before independently truncating channel fallback', () => {
	const options = fixture(1_350);
	options.template.defaultMidRoll = null;
	options.template.defaultFiller = { programId: uuid(11), presetId: uuid(401), policy: 'best-fit-only' };
	options.catalog.fillerPresets = { [uuid(401)]: { budget: { type: 'duration', seconds: 100, policy: 'best-fit-only' } } };
	options.schedule.defaultFiller = { programId: uuid(11), policy: 'next-truncate' };
	const result = generateTimelineDetailed(options);
	const fills = result.segments.filter(segment => segment.role === 'filler' && Date.parse(segment.start) < Date.parse('2026-01-05T00:22:30Z'));
	expect(fills.map(segment => Date.parse(segment.finish) - Date.parse(segment.start))).toEqual([30_000, 30_000, 30_000, 30_000, 30_000]);
	expect(fills.map(segment => segment.fillerStage)).toEqual(['tail', 'tail', 'tail', 'fallback', 'fallback']);
	expect(result.proposedState.some(record => record.consumerKey.startsWith('fallback:'))).toBe(true);
	options.template.slots[0]!.filler = { mode: 'disabled' };
	const disabled = generateTimelineDetailed(options);
	expect(disabled.segments[1]?.role).toBe('filler');
	expect(disabled.proposedState.some(record => record.consumerKey.startsWith('filler:'))).toBe(false);
});
it('pads pre and post independently using the preceding stages’ actual finish', () => {
	const options = fixture(1_800);
	options.template.defaultMidRoll = null;
	options.initialCursor = '2026-01-05T00:00:30Z';
	options.template.defaultPreRoll = { presetId: uuid(401), programId: uuid(11) };
	options.template.defaultPostRoll = { presetId: uuid(402), programId: uuid(11) };
	options.catalog.fillerPresets = { [uuid(401)]: { budget: { type: 'pad', minutes: 5, policy: 'next-truncate' } }, [uuid(402)]: { budget: { type: 'pad', minutes: 15, policy: 'next-truncate' } } };
	const result = generateTimelineDetailed(options);
	const primary = result.segments.find(segment => segment.role === 'primary')!;
	expect(primary.start).toBe('2026-01-05T00:05:00Z');
	expect(primary.finish).toBe('2026-01-05T00:25:00Z');
	expect(primary.airing?.finish).toBe('2026-01-05T00:30:00Z');
});

it('does not consume primary selection when truncation would show only pre-roll', () => {
	const options = fixture(20);
	options.template.defaultMidRoll = null;
	options.template.slots[0]!.startEligibility = { type: 'allow-truncate' };
	options.template.defaultPreRoll = { presetId: uuid(401), programId: uuid(11) };
	options.catalog.fillerPresets = { [uuid(401)]: { budget: { type: 'count', count: 1 } } };
	const result = generateTimelineDetailed(options);
	expect(result.segments[0]?.role).toBe('dead-air');
	expect(result.proposedState).toEqual([]);
});
it('does not mark complete primary content truncated when only post-roll is cut', () => {
	const options = fixture(1_210);
	options.template.defaultMidRoll = null;
	options.template.slots[0]!.startEligibility = { type: 'allow-truncate' };
	options.template.defaultPostRoll = { presetId: uuid(401), programId: uuid(11) };
	options.catalog.fillerPresets = { [uuid(401)]: { budget: { type: 'count', count: 1 } } };
	const result = generateTimelineDetailed(options);
	expect(result.segments[0]).toMatchObject({ role: 'primary', truncated: false, airing: { truncated: false } });
	expect(result.segments[1]).toMatchObject({ role: 'filler', fillerStage: 'post-roll', truncated: true });
});

it('enforces the shared speculative span ceiling before accepting another filler item', () => {
	const options = fixture();
	const context = {
		programs: new Map(options.programs.map(program => [program.id, program])), catalog: options.catalog,
		boundaryOrigin: 'template' as const, templateId: options.template.id, scheduleLayerId: null, slotId: options.template.slots[0]!.id,
		candidateCache: new Map(), blockedPrograms: new Set<string>(), fitRejectionCount: 0, issues: [], issueKeys: new Set<string>(), issueIndex: new Map(),
		now: '2026-01-01T00:00:00Z', selectionStart: '2026-01-01T00:00:00Z', occupiedMedia: [], viewingPreferences: { itemScores: {}, showScores: {} },
	};
	expect(() => planFiller(uuid(11), { type: 'count', count: 2 }, new Map(), context, 'tail:fixture', 'UTC', 'fixture', Infinity, undefined, 1)).toThrow(TimelineMaterializationLimitError);
});

it.each([
	{ budget: { type: 'duration', seconds: 75, policy: 'next-truncate' }, seconds: 75 },
	{ budget: { type: 'count', count: 2 }, seconds: 60 },
	{ budget: { type: 'random-count', minimum: 2, maximum: 2 }, seconds: 60 },
	{ budget: { type: 'pad', minutes: 5, policy: 'next-truncate' }, seconds: 170 },
	{ budget: { type: 'remaining', policy: 'next-truncate' }, seconds: 170 },
] satisfies Array<{ budget: import('@moirai/shared').FillerBudget; seconds: number }>)('fills an actual tail gap with a $budget.type budget and retains the primary offset', ({ budget, seconds }) => {
	const options = fixture(1_380);
	options.template.defaultMidRoll = null;
	options.catalog.media[0]!.durationSeconds = 1_210;
	options.template.defaultFiller = { programId: uuid(11), presetId: uuid(401), policy: 'next-truncate' };
	options.catalog.fillerPresets = { [uuid(401)]: { budget } };
	const before = structuredClone(options.state ?? []);
	const result = generateTimelineDetailed(options);
	const end = Date.parse('2026-01-05T00:23:00Z');
	const fills = result.segments.filter(segment => segment.role === 'filler' && Date.parse(segment.start) < end);
	expect(fills.reduce((sum, segment) => sum + (Date.parse(segment.finish) - Date.parse(segment.start)) / 1000, 0)).toBe(seconds);
	expect(result.segments[0]).toMatchObject({ role: 'primary', sourceStartSeconds: 0, sourceFinishSeconds: 1_210 });
	expect(result.proposedState.some(record => record.consumerKey.startsWith('filler:'))).toBe(true);
	expect(options.state ?? []).toEqual(before);
});

it('preserves migrated channel filler in empty slots without overriding disabled primary slots', () => {
	const primary = contentProgram(10, 1);
	const fill = contentProgram(11, 2);
	const daily = template([{ programId: primary.id, startSeconds: 0, filler: { mode: 'disabled' } },
		{ programId: null, startSeconds: 60, filler: { mode: 'disabled' } },
		{ programId: primary.id, startSeconds: 120, filler: { mode: 'disabled' } }]);
	const options = input([primary, fill], [media(1, 90), media(2, 30)], daily);
	options.schedule.defaultTailFiller = { programId: fill.id, policy: 'best-fit-only', legacyEmptySlots: true };
	const result = generateTimelineDetailed(options);
	expect(result.segments.filter(span => Date.parse(span.start) < Date.parse('2026-01-05T00:02:00Z'))
		.map(span => [span.role, span.sourceFinishSeconds])).toEqual([['dead-air', null], ['filler', 30], ['filler', 30]]);
	const key = `filler:${options.channelId}:${daily.id}:${daily.slots[1]!.id}:${fill.id}`;
	expect(result.proposedState.some(record => record.consumerKey === key)).toBe(true);
	expect(result.proposedState.some(record => record.consumerKey.startsWith('fallback:'))).toBe(false);

	options.schedule.defaultTailFiller.legacyEmptySlots = false;
	const fresh = generateTimelineDetailed(options);
	expect(fresh.segments.filter(span => Date.parse(span.start) < Date.parse('2026-01-05T00:02:00Z'))
		.every(span => span.role === 'dead-air')).toBe(true);
});

it('replenishes migrated tail behind deferred clips without starting a fallback cursor', () => {
	const primary = contentProgram(10, 1);
	const fill = program(11, { type: 'content', source: { type: 'collection', libraryId: uuid(900),
		itemIds: [uuid(2), uuid(3)], sort: { type: 'date-added', direction: 'asc' } }, strategy: { type: 'sequential' } });
	const daily = template([{ programId: primary.id, startSeconds: 0 }, { programId: null, startSeconds: 180 }]);
	const options = input([primary, fill], [media(1, 100), media(2, 30), media(3, 120)], daily);
	options.schedule.defaultTailFiller = { programId: fill.id, policy: 'next-fit-only', legacyEmptySlots: true };
	const result = generateTimelineDetailed(options);
	expect(result.segments.filter(span => Date.parse(span.start) < Date.parse('2026-01-05T00:03:00Z'))
		.map(span => [span.role, span.sourceFinishSeconds])).toEqual([['primary', 100], ['filler', 30], ['filler', 30], ['dead-air', null]]);
	expect(result.proposedState.some(record => record.consumerKey.startsWith('fallback:'))).toBe(false);
});

it('continues an existing migrated empty-slot filler cursor instead of starting fallback progress', () => {
	const primary = contentProgram(10, 1);
	const fill = program(11, { type: 'content', source: { type: 'collection', libraryId: uuid(900),
		itemIds: [uuid(2), uuid(3)], sort: { type: 'date-added', direction: 'asc' } }, strategy: { type: 'sequential' } });
	const daily = template([{ programId: null, startSeconds: 0, filler: { mode: 'disabled' } },
		{ programId: primary.id, startSeconds: 60, filler: { mode: 'disabled' } }]);
	const options = input([primary, fill], [media(1, 86_400), media(2, 20), media(3, 30)], daily);
	options.schedule.defaultTailFiller = { programId: fill.id, policy: 'next-fit-only', legacyEmptySlots: true };
	const prior = generateTimelineDetailed(options).proposedState.find(record => record.consumerKey.startsWith('filler:'))!;
	options.state = [{ ...prior, value: { type: 'sequential', nextIndex: 1, lastItemId: uuid(2) } }];
	const continued = generateTimelineDetailed(options);
	expect(continued.segments.filter(span => span.role === 'filler').map(span => span.mediaItemId)).toEqual([uuid(3), uuid(2)]);
	expect(continued.proposedState.find(record => record.consumerKey === prior.consumerKey)?.value)
		.toMatchObject({ type: 'sequential', lastItemId: uuid(2) });
	expect(continued.proposedState.some(record => record.consumerKey.startsWith('fallback:'))).toBe(false);
});

describe('roll shortfall tolerance', () => {
	it.each(['pre-roll', 'mid-roll', 'post-roll'] as const)('warns below the strict percentage for %s without changing playback or state', stage => {
		const options = fixture(1_500);
		options.catalog.media[1]!.durationSeconds = 96;
		const budget = { type: 'duration' as const, seconds: 120, policy: 'next-fit-only' as const };
		if (stage === 'mid-roll') {
			settings(options).budget = budget;
		}
		else {
			options.template.defaultMidRoll = null;
			options.template[stage === 'pre-roll' ? 'defaultPreRoll' : 'defaultPostRoll'] = { presetId: uuid(401), programId: uuid(11) };
			options.catalog.fillerPresets = { [uuid(401)]: { budget } };
		}
		const original = structuredClone(options);
		const quiet = generateTimelineDetailed(options);
		expect(quiet.issues.some(issue => issue.code === 'mid-roll-shortfall')).toBe(false);
		const noisy = generateTimelineDetailed({ ...options, fillerShortfallWarningThresholdPercent: 100 });
		expect(noisy.issues.some(issue => issue.code === 'mid-roll-shortfall')).toBe(true);
		for (const field of ['segments', 'proposedState', 'stateTransitions', 'continuation'] as const) {
			expect(noisy[field]).toEqual(quiet[field]);
		}
		expect(options).toEqual(original);
		options.catalog.media[1]!.durationSeconds = 95.999;
		expect(generateTimelineDetailed(options).issues.some(issue => issue.code === 'mid-roll-shortfall')).toBe(true);
		options.catalog.media[1]!.durationSeconds = 96.001;
		expect(generateTimelineDetailed(options).issues.some(issue => issue.code === 'mid-roll-shortfall')).toBe(false);
	});
	it('disables only budget-shortfall diagnostics at zero', () => {
		const options = fixture();
		settings(options).budget = { type: 'duration', seconds: 120, policy: 'next-fit-only' };
		options.catalog.media[1]!.durationSeconds = null;
		const noisy = generateTimelineDetailed(options);
		const quiet = generateTimelineDetailed({ ...options, fillerShortfallWarningThresholdPercent: 0 });
		expect(noisy.issues.some(issue => issue.code === 'mid-roll-shortfall')).toBe(true);
		expect(quiet.issues).toEqual(noisy.issues.filter(issue => issue.code !== 'mid-roll-shortfall'));
		expect(quiet.segments).toEqual(noisy.segments);
	});
});

it('applies warning tolerance to clock padding at the actual mid-roll position', () => {
	const options = fixture(1_600);
	settings(options).budget = { type: 'pad', minutes: 15, policy: 'next-fit-only' };
	options.catalog.media[1]!.durationSeconds = 240;
	expect(generateTimelineDetailed(options).issues.some(issue => issue.code === 'mid-roll-shortfall')).toBe(false);
	options.catalog.media[1]!.durationSeconds = 239.999;
	expect(generateTimelineDetailed(options).issues.some(issue => issue.code === 'mid-roll-shortfall')).toBe(true);
});

it.each([{ type: 'count', count: 1 }, { type: 'random-count', minimum: 1, maximum: 1 }] as const)('reports a missing resolved quantity for $type but suppresses zero quantities', budget => {
	const options = fixture();
	settings(options).budget = budget;
	options.catalog.media[1]!.durationSeconds = null;
	expect(generateTimelineDetailed(options).issues.some(issue => issue.code === 'mid-roll-shortfall')).toBe(true);
	options.fillerShortfallWarningThresholdPercent = 0;
	expect(generateTimelineDetailed(options).issues.some(issue => issue.code === 'mid-roll-shortfall')).toBe(false);
	options.fillerShortfallWarningThresholdPercent = 100;
	settings(options).budget = { type: 'random-count', minimum: 0, maximum: 0 };
	expect(generateTimelineDetailed(options).issues.some(issue => issue.code === 'mid-roll-shortfall')).toBe(false);
});
