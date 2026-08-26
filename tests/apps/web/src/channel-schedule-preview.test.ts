import { describe, expect, it } from 'vitest';
import type { ScheduleTemplate, TimelinePreview } from '@moirai/shared';
import { schedulePreviewLegend, scheduleRulerMarks } from '@web/channel-schedule-preview';

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
