import { describe, expect, it } from 'vitest';
import type { ScheduleGuide, ScheduleTemplate, TimelinePreview } from '@moirai/shared';
import { guideCoversScheduleWindow, upcomingScheduleSummary, upcomingScheduleWindow, schedulePreviewLegend, scheduleRulerMarks } from '@web/channel-schedule-preview';

function preview(
	segments: Array<Pick<TimelinePreview['segments'][number], 'start' | 'finish' | 'role'>>,
	startDate = '2026-09-02',
): TimelinePreview {
	return { startDate, timeZone: 'America/Los_Angeles', days: 7, segments } as TimelinePreview;
}

describe('upcoming 24-hour guide summary', () => {
	const now = Date.parse('2026-09-02T19:00:00Z');
	const window = upcomingScheduleWindow(now, 'America/Los_Angeles');

	it('excludes elapsed and later gaps from a cached week, retaining ongoing programming', () => {
		expect(upcomingScheduleSummary(preview([
			{ role: 'dead-air', start: '2026-09-02T07:00:00Z', finish: '2026-09-02T18:00:00Z' },
			{ role: 'primary', start: '2026-09-02T18:00:00Z', finish: '2026-09-03T19:00:00Z' },
			{ role: 'dead-air', start: '2026-09-03T19:00:00Z', finish: '2026-09-03T20:00:00Z' },
		]), window)).toEqual({ gapCount: 0, deadAirSeconds: 0, programmedCount: 1 });
	});

	it('clips gaps at now and 24 hours later, excluding intervals merely touching the window', () => {
		expect(upcomingScheduleSummary(preview([
			{ role: 'dead-air', start: '2026-09-02T18:00:00Z', finish: '2026-09-02T19:00:00Z' },
			{ role: 'dead-air', start: '2026-09-02T18:59:00Z', finish: '2026-09-02T19:00:12.5Z' },
			{ role: 'dead-air', start: '2026-09-03T18:52:00Z', finish: '2026-09-03T19:08:00Z' },
			{ role: 'dead-air', start: '2026-09-03T19:00:00Z', finish: '2026-09-03T20:00:00Z' },
		]), window)).toEqual({ gapCount: 2, deadAirSeconds: 492.5, programmedCount: 0 });
	});

	it('counts adjacent daily dead-air segments as one uninterrupted gap', () => {
		expect(upcomingScheduleSummary(preview([
			{ role: 'dead-air', start: '2026-09-02T19:00:00Z', finish: '2026-09-03T07:00:00Z' },
			{ role: 'dead-air', start: '2026-09-03T07:00:00Z', finish: '2026-09-03T19:00:00Z' },
		]), window)).toEqual({ gapCount: 1, deadAirSeconds: 86_400, programmedCount: 0 });
	});

	it.each([
		{ instant: '2026-03-08T07:30:00Z', startDate: '2026-03-07', days: 3 },
		{ instant: '2026-03-08T08:00:00Z', startDate: '2026-03-08', days: 2 },
		{ instant: '2026-11-01T07:00:00Z', startDate: '2026-11-01', days: 1 },
	])('covers exactly 24 elapsed hours across DST at $instant', ({ instant, startDate, days }) => {
		const range = upcomingScheduleWindow(Date.parse(instant), 'America/Los_Angeles');
		expect(range).toMatchObject({ startDate, days });
		expect(range.finish - range.start).toBe(24 * 3_600_000);
		expect(upcomingScheduleSummary(preview([{
			role: 'dead-air', start: '2026-01-01T00:00:00Z', finish: '2027-01-01T00:00:00Z',
		}], startDate), range)).toEqual({ gapCount: 1, deadAirSeconds: 86_400, programmedCount: 0 });
	});

	it('requests only dates touched by the exclusive end, and rolls forward after midnight', () => {
		const midnight = Date.parse('2026-09-03T07:00:00Z');
		expect(upcomingScheduleWindow(midnight - 1, 'America/Los_Angeles'))
			.toMatchObject({ startDate: '2026-09-02', days: 2 });
		expect(upcomingScheduleWindow(midnight, 'America/Los_Angeles'))
			.toMatchObject({ startDate: '2026-09-03', days: 1 });
		expect(upcomingScheduleWindow(midnight + 1, 'America/Los_Angeles'))
			.toMatchObject({ startDate: '2026-09-03', days: 2 });
	});

	it('reuses covering ranges and rejects short, future, or differently zoned caches', () => {
		const guide = { startDate: '2026-09-01', days: 7, timeZone: window.timeZone } as ScheduleGuide;
		expect(guideCoversScheduleWindow(guide, window)).toBe(true);
		expect(guideCoversScheduleWindow({ ...guide, startDate: window.startDate, days: 1 }, window)).toBe(false);
		expect(guideCoversScheduleWindow({ ...guide, startDate: '2026-09-03' }, window)).toBe(false);
		expect(guideCoversScheduleWindow({ ...guide, timeZone: 'UTC' }, window)).toBe(false);
		expect(guideCoversScheduleWindow(null, window)).toBe(false);
	});

	it('returns zero counts for a loaded empty preview', () => {
		expect(upcomingScheduleSummary(preview([]), window))
			.toEqual({ gapCount: 0, deadAirSeconds: 0, programmedCount: 0 });
	});
});

describe('channel schedule preview presentation', () => {
	it('creates a full-day ruler from documented scheduling-day boundaries', () => {
		const marks = scheduleRulerMarks();
		expect(marks).toHaveLength(9);
		expect(marks[0]).toEqual({ seconds: 0, label: '00:00' });
		expect(marks.at(-1)).toEqual({ seconds: 86_400, label: '24:00' });
	});

	it('groups resolved program colors by template and identifies the base template', () => {
		const templates = [
			{ id: 'base', name: 'Base' },
			{ id: 'layer', name: 'Layer' },
		] as ScheduleTemplate[];
		const preview = {
			segments: [
				{ templateId: 'layer', scheduleLayerId: 'conditional', programId: 'program-a' },
				{ templateId: 'layer', scheduleLayerId: 'conditional', programId: 'program-b' },
				{ templateId: 'base', scheduleLayerId: null, programId: 'program-c' },
			],
		} as TimelinePreview;

		expect(schedulePreviewLegend(preview, templates, 'base')).toEqual([
			{
				templateId: 'layer',
				name: 'Layer',
				programIds: ['program-a', 'program-b'],
				isBase: false,
			},
			{
				templateId: 'base',
				name: 'Base',
				programIds: ['program-c'],
				isBase: true,
			},
		]);
	});
});
