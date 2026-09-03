import { describe, expect, it } from 'vitest';
import type { ScheduleTemplate, TimelinePreview } from '@moirai/shared';
import { firstDayScheduleSummary, schedulePreviewLegend, scheduleRulerMarks } from '@web/channel-schedule-preview';

function preview(
	segments: Array<Pick<TimelinePreview['segments'][number], 'start' | 'finish' | 'role'>>,
	startDate = '2026-09-02',
): TimelinePreview {
	return { startDate, timeZone: 'America/Los_Angeles', days: 7, segments } as TimelinePreview;
}

describe('first local guide day summary', () => {
	it('excludes later days in a cached week while counting programming carried into today', () => {
		expect(firstDayScheduleSummary(preview([
			{ role: 'primary', start: '2026-09-02T06:30:00Z', finish: '2026-09-02T07:30:00Z' },
			{ role: 'filler', start: '2026-09-02T07:30:00Z', finish: '2026-09-03T07:00:00Z' },
			{ role: 'dead-air', start: '2026-09-03T07:00:00Z', finish: '2026-09-03T07:08:00Z' },
			{ role: 'primary', start: '2026-09-03T07:08:00Z', finish: '2026-09-03T08:00:00Z' },
		]))).toEqual({ gapCount: 0, deadAirSeconds: 0, programmedCount: 2 });
	});

	it('clips gaps at both midnight boundaries and excludes intervals merely touching the day', () => {
		expect(firstDayScheduleSummary(preview([
			{ role: 'dead-air', start: '2026-09-02T06:00:00Z', finish: '2026-09-02T07:00:00Z' },
			{ role: 'dead-air', start: '2026-09-02T06:59:00Z', finish: '2026-09-02T07:00:12.5Z' },
			{ role: 'dead-air', start: '2026-09-03T06:52:00Z', finish: '2026-09-03T07:08:00Z' },
			{ role: 'dead-air', start: '2026-09-03T07:00:00Z', finish: '2026-09-03T08:00:00Z' },
		]))).toEqual({ gapCount: 2, deadAirSeconds: 492.5, programmedCount: 0 });
	});

	it.each([
		{ day: '2026-03-08', start: '2026-03-08T07:00:00Z', finish: '2026-03-09T08:00:00Z', hours: 23 },
		{ day: '2026-11-01', start: '2026-11-01T06:00:00Z', finish: '2026-11-02T09:00:00Z', hours: 25 },
	])('clips a spanning gap to the $hours-hour local day on $day', ({ day, start, finish, hours }) => {
		expect(firstDayScheduleSummary(preview([{ role: 'dead-air', start, finish }], day)))
			.toEqual({ gapCount: 1, deadAirSeconds: hours * 3600, programmedCount: 0 });
	});

	it('returns zero counts for a loaded empty preview', () => {
		expect(firstDayScheduleSummary(preview([])))
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
