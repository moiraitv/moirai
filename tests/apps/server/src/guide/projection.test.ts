import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SECONDS_PER_SCHEDULING_DAY, scheduleTemplateCreateSchema, type GuideOccurrence, type ScheduleTemplate, type TimelineSegment } from '@moirai/shared';
import { guideTimelinePreview } from '@server/guide/preview.js';
import { projectGuideEntries } from '@server/guide/projection.js';
import { mergeGuideOccurrences } from '@server/guide/occurrences.js';
import { generateTimelineDetailed } from '@server/scheduling/engine.js';

const channelId = randomUUID();
const date = '2026-09-10';
const start = `${date}T00:00:00Z`;
const finish = '2026-09-11T00:00:00Z';

function fixture() {
	const slotId = randomUUID();
	const template: ScheduleTemplate = {
		...scheduleTemplateCreateSchema.parse({
			name: 'Music', slots: [{ id: slotId, startSeconds: 0, programId: null, filler: { mode: 'disabled' },
				guide: { mode: 'block', title: 'Rock Music', description: 'A music hour', boundary: 'scheduled' } }],
			boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard' }],
		}),
		id: randomUUID(), createdAt: start, updatedAt: start,
	};
	const occurrence: GuideOccurrence = {
		id: 'occurrence', templateId: template.id, slotId, scheduleLayerId: null, programId: null,
		start: `${date}T08:00:00Z`, finish: `${date}T09:00:00Z`,
		actualStart: `${date}T08:02:00Z`, actualFinish: `${date}T09:04:00Z`,
	};
	const segments: TimelineSegment[] = [
		['07:58', '08:02', 'Previous slot'], ['08:02', '08:06', 'Video 1'],
		['08:06', '09:04', 'Video 2'], ['09:04', '09:08', 'Next slot'],
	].map(([from, to, title]) => ({
		id: randomUUID(), channelId, templateId: template.id, slotId, scheduleLayerId: null,
		role: 'primary', title: title!, programId: null, mediaItemId: null, playbackPath: null,
		start: `${date}T${from}:00Z`, finish: `${date}T${to}:00Z`,
		sourceStartSeconds: 0, sourceFinishSeconds: null, truncated: false,
	}));
	return { template, occurrence, segments };
}

describe('slot guide projection', () => {
	it.each(['', '   '])('uses the program name for a blank override %j', (title) => {
		const { template, occurrence, segments } = fixture();
		occurrence.programId = randomUUID();
		template.slots[0]!.programId = occurrence.programId;
		template.slots[0]!.guide = { mode: 'block', title, boundary: 'scheduled', description: '' };
		const parsed = { ...template, ...scheduleTemplateCreateSchema.parse(template) };
		const names = new Map([[occurrence.programId, 'Music Videos']]);
		const entries = projectGuideEntries(channelId, segments, [occurrence], [parsed], start, finish, names);
		expect(entries.find((entry) => entry.kind === 'block')?.title).toBe('Music Videos');
		names.set(occurrence.programId, 'Renamed Program');
		expect(projectGuideEntries(channelId, segments, [occurrence], [parsed], start, finish, names)
			.find((entry) => entry.kind === 'block')?.title).toBe('Renamed Program');
	});

	it('uses hard clock times and clips neighboring listings without changing actual items', () => {
		const { template, occurrence, segments } = fixture();
		const before = structuredClone(segments);
		const entries = projectGuideEntries(channelId, segments, [occurrence], [template], start, finish);
		expect(entries.map((entry) => [entry.title, entry.start, entry.finish])).toEqual([
			['Previous slot', `${date}T07:58:00Z`, `${date}T08:00:00Z`],
			['Rock Music', occurrence.start, occurrence.finish],
			['Video 2', `${date}T09:00:00Z`, `${date}T09:04:00Z`],
			['Next slot', `${date}T09:04:00Z`, `${date}T09:08:00Z`],
		]);
		expect(segments).toEqual(before);
		expect(entries[1]).toMatchObject({ description: 'A music hour', segmentId: null, kind: 'block' });
		expect(entries[2]?.segmentId).toBe(segments[2]?.id);
		expect(projectGuideEntries(channelId, segments, [occurrence], [template], start, finish)).toEqual(entries);
	});

	it('follows both actual boundaries and omits a completely displaced drift block', () => {
		const { template, occurrence, segments } = fixture();
		template.slots[0]!.guide = { mode: 'block', boundary: 'drift', title: 'Rock Music', description: '' };
		const entries = projectGuideEntries(channelId, segments, [occurrence], [template], start, finish);
		expect(entries.find((entry) => entry.kind === 'block')).toMatchObject({ start: occurrence.actualStart, finish: occurrence.actualFinish });
		occurrence.actualStart = null;
		occurrence.actualFinish = null;
		expect(projectGuideEntries(channelId, segments, [occurrence], [template], start, finish)).toHaveLength(segments.length);
		template.slots[0]!.guide.boundary = 'scheduled';
		expect(projectGuideEntries(channelId, segments, [occurrence], [template], start, finish).some((entry) => entry.kind === 'block')).toBe(true);
	});

	it('gives a hard block precedence over overlapping drift and splits guide items only', () => {
		const { template, occurrence, segments } = fixture();
		const other = structuredClone(template);
		other.id = randomUUID();
		other.slots[0]!.guide = { mode: 'block', boundary: 'drift', title: 'Long block', description: '' };
		const long = { ...occurrence, id: 'long', templateId: other.id, actualStart: `${date}T07:00:00Z`, actualFinish: `${date}T10:00:00Z` };
		const entries = projectGuideEntries(channelId, segments, [occurrence, long], [template, other], start, finish);
		expect(entries.map((entry) => entry.title)).toEqual(['Long block', 'Rock Music', 'Long block']);
		expect(entries[0]?.finish).toBe(occurrence.start);
		expect(entries[2]?.start).toBe(occurrence.finish);
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(3);
	});

	it('clips a block to the requested window while keeping its occurrence identity', () => {
		const { template, occurrence, segments } = fixture();
		const entries = projectGuideEntries(channelId, segments, [occurrence], [template], `${date}T08:30:00Z`, `${date}T08:45:00Z`);
		const block = entries.find((entry) => entry.kind === 'block');
		expect(block).toMatchObject({ start: `${date}T08:30:00Z`, finish: `${date}T08:45:00Z`, occurrenceId: occurrence.id });
	});

	it('normalizes spring-forward scheduled overlaps without widening the preview day', () => {
		const { template } = fixture();
		template.slots = [0, 2.5 * 3600, 3 * 3600].map((startSeconds, index) => ({
			...template.slots[0]!, id: randomUUID(), startSeconds,
			guide: { mode: 'block', title: `Slot ${index}`, description: '', boundary: 'scheduled' },
		}));
		template.boundaries = template.slots.map((slot, index) => ({
			...template.boundaries[0]!, id: randomUUID(), leftSlotId: slot.id,
			rightSlotId: template.slots[(index + 1) % template.slots.length]!.id,
			targetSeconds: template.slots[index + 1]?.startSeconds ?? SECONDS_PER_SCHEDULING_DAY,
		}));
		const input = {
			channelId, timeZone: 'America/Los_Angeles', startDate: '2026-03-08', days: 1,
			template, templates: [template], programs: [], state: [],
			schedule: { channelId, defaultTemplateId: template.id, defaultFiller: null, layers: [], createdAt: start, updatedAt: start },
			catalog: { media: [], groupParents: {}, groupTitles: {}, libraryNames: {}, libraryAvailability: {} },
		};
		const generated = generateTimelineDetailed(input);
		const before = structuredClone(generated);
		const preview = guideTimelinePreview(generated, input.templates, []);
		expect(preview.entries?.map((entry) => [entry.title, entry.start, entry.finish])).toEqual([
			['Slot 0', '2026-03-08T08:00:00Z', '2026-03-08T10:00:00Z'],
			['Slot 2', '2026-03-08T10:00:00Z', '2026-03-09T07:00:00Z'],
		]);
		expect(preview.entries?.reduce((sum, entry) => sum + Date.parse(entry.finish) - Date.parse(entry.start), 0)).toBe(23 * 3600_000);
		expect(generated).toEqual(before);
	});

	it.each(['2026-03-08', '2026-11-01'])('records actual local-day boundaries on %s without affecting generation', (startDate) => {
		const { template } = fixture();
		const input = {
			channelId, timeZone: 'America/Los_Angeles', startDate, days: 2, template, templates: [template],
			schedule: { channelId, defaultTemplateId: template.id, defaultFiller: null, layers: [], createdAt: start, updatedAt: start },
			programs: [], state: [], catalog: { media: [], groupParents: {}, groupTitles: {}, libraryNames: {}, libraryAvailability: {} },
		};
		const grouped = generateTimelineDetailed(input);
		const preview = guideTimelinePreview(grouped, input.templates, input.programs);
		expect(preview.entries).toEqual(projectGuideEntries(
			channelId,
			grouped.segments,
			grouped.guideOccurrences,
			input.templates,
			grouped.segments[0]!.start,
			grouped.segments.at(-1)!.finish,
		));
		expect(preview.segments).toEqual(grouped.segments);
		expect(preview.proposedState).toEqual(grouped.proposedState);
		delete template.slots[0]!.guide;
		const individual = generateTimelineDetailed(input);
		expect(grouped.segments).toEqual(individual.segments);
		expect(grouped.proposedState).toEqual(individual.proposedState);
		expect(grouped.guideOccurrences.slice(0, 2).map((entry) => [entry.start, entry.finish])).toEqual(
			grouped.segments.map((entry) => [entry.start, entry.finish]),
		);
		expect(grouped.guideOccurrences[0]?.id).not.toBe(grouped.guideOccurrences[1]?.id);
	});

	it('clips replacement blocks at a delayed configuration handoff and preserves the clip on resume', () => {
		const { template, occurrence, segments } = fixture();
		const handoff = `${date}T08:30:00Z`;
		const replacement = { ...occurrence, id: 'replacement', finish: `${date}T10:00:00Z`,
			actualStart: handoff, actualFinish: `${date}T10:02:00Z` };
		const before = structuredClone([occurrence, replacement]);
		const merged = mergeGuideOccurrences([occurrence], [replacement], start, finish, handoff);
		expect(merged.map((entry) => [Date.parse(entry.start), Date.parse(entry.finish)])).toEqual([
			[Date.parse(occurrence.start), Date.parse(handoff)],
			[Date.parse(handoff), Date.parse(replacement.finish)],
		]);
		const entries = projectGuideEntries(channelId, segments, merged, [template], start, finish)
			.filter((entry) => entry.kind === 'block');
		expect(entries).toHaveLength(2);
		expect(Date.parse(entries[0]!.finish)).toBe(Date.parse(entries[1]!.start));
		const resumed = mergeGuideOccurrences(merged, [replacement], start, finish, `${date}T09:00:00Z`);
		expect(resumed).toEqual(merged);
		expect([occurrence, replacement]).toEqual(before);
	});

	it('keeps drift-only replacements valid when retained history consumes their nominal interval', () => {
		const { occurrence } = fixture();
		const replacement = { ...occurrence, id: 'replacement', finish: `${date}T08:20:00Z`,
			actualStart: `${date}T08:30:00Z`, actualFinish: `${date}T08:40:00Z` };
		const merged = mergeGuideOccurrences([occurrence], [replacement], start, finish, `${date}T08:30:00Z`);
		expect(merged.find((entry) => entry.id === replacement.id)).toMatchObject({
			start: replacement.finish, finish: replacement.finish,
			actualStart: replacement.actualStart, actualFinish: replacement.actualFinish,
		});
	});

	it('retains the first actual start when a committed occurrence resumes', () => {
		const { occurrence } = fixture();
		const next = { ...occurrence, actualStart: `${date}T08:30:00Z` };
		const merged = mergeGuideOccurrences([occurrence], [next], start, finish, `${date}T08:30:00Z`);
		expect(merged).toEqual([occurrence]);
		expect(next.actualStart).toBe(`${date}T08:30:00Z`);
	});
});

it('keeps early-started next-day occurrences when their nominal start is outside the window', () => {
	const { occurrence } = fixture();
	const early = { ...occurrence, start: finish, finish: '2026-09-12T00:00:00Z',
		actualStart: '2026-09-10T23:50:00Z', actualFinish: '2026-09-11T00:20:00Z' };
	expect(mergeGuideOccurrences([], [early], start, finish, start)).toEqual([early]);
});

it('splits nominal blocks around a higher-priority layer and ignores fall-through presentation', () => {
	const { template } = fixture();
	const override = structuredClone(template);
	override.id = randomUUID();
	override.slots[0]!.id = randomUUID();
	override.slots[0]!.programId = randomUUID();
	override.slots[0]!.guide = { mode: 'block', title: 'Special', boundary: 'scheduled', description: '' };
	override.boundaries[0]!.leftSlotId = override.slots[0]!.id;
	override.boundaries[0]!.rightSlotId = override.slots[0]!.id;
	const layer = {
		id: randomUUID(), templateId: override.id,
		predicate: { type: 'time-range' as const, negated: false, startSeconds: 8 * 3600, endSeconds: 9 * 3600 },
		entryBoundary: { policy: 'hard' as const, maxDriftSeconds: 0, fallback: 'reject-start' as const, earlyStartMaxDriftSeconds: 0 },
		exitBoundary: { policy: 'hard' as const, maxDriftSeconds: 0, fallback: 'reject-start' as const, earlyStartMaxDriftSeconds: 0 },
	};
	const input = {
		channelId, timeZone: 'UTC', startDate: date, days: 1, template, templates: [template, override],
		schedule: { channelId, defaultTemplateId: template.id, defaultFiller: null, layers: [layer], createdAt: start, updatedAt: start },
		programs: [], state: [], catalog: { media: [], groupParents: {}, groupTitles: {}, libraryNames: {}, libraryAvailability: {} },
	};
	const generated = generateTimelineDetailed(input);
	const entries = projectGuideEntries(channelId, generated.segments, generated.guideOccurrences, input.templates, start, finish);
	expect(entries.map((entry) => [entry.title, entry.start, entry.finish])).toEqual([
		['Rock Music', start, `${date}T08:00:00Z`],
		['Special', `${date}T08:00:00Z`, `${date}T09:00:00Z`],
		['Rock Music', `${date}T09:00:00Z`, finish],
	]);
	override.slots[0]!.programId = null;
	const fallThrough = generateTimelineDetailed(input);
	expect(projectGuideEntries(channelId, fallThrough.segments, fallThrough.guideOccurrences, input.templates, start, finish))
		.toMatchObject([{ title: 'Rock Music', start, finish }]);
});

it('clips fractional-second media using chronological rather than textual ordering', () => {
	const { template, occurrence, segments } = fixture();
	segments[0]!.finish = `${date}T08:00:00.500Z`;
	const entries = projectGuideEntries(channelId, segments.slice(0, 1), [occurrence], [template], start, finish);
	expect(entries.map((entry) => [entry.kind, entry.start, entry.finish])).toEqual([
		['item', segments[0]!.start, occurrence.start],
		['block', occurrence.start, occurrence.finish],
	]);
});
