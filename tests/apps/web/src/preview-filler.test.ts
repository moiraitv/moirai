import { describe, expect, it } from 'vitest';
import type { TimelinePreview, TimelineSegment } from '@moirai/shared';
import { previewFillerTicks } from '@web/preview-filler.js';

function span(id: string, stage: TimelineSegment['fillerStage'], start: string, finish: string, airingId = 'airing'): TimelineSegment {
	return { id, role: stage ? 'filler' : 'primary', fillerStage: stage, start, finish, slotId: 'slot',
		templateId: 'template', scheduleLayerId: null, airing: airingId ? { id: airingId } : null } as TimelineSegment;
}

function preview(segments: TimelineSegment[], startDate = '2026-01-01', timeZone = 'UTC'): TimelinePreview {
	return { segments, startDate, timeZone, days: 1 } as TimelinePreview;
}

describe('preview filler ticks', () => {
	it('marks all stages and combines clips only within the same continuous break', () => {
		const segments = [
			span('pre1', 'pre-roll', '2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'),
			span('pre2', 'pre-roll', '2026-01-01T00:00:10Z', '2026-01-01T00:00:20Z'),
			span('primary1', undefined, '2026-01-01T00:00:20Z', '2026-01-01T00:10:00Z'),
			span('mid1', 'mid-roll', '2026-01-01T00:10:00Z', '2026-01-01T00:10:30Z'),
			span('primary2', undefined, '2026-01-01T00:10:30Z', '2026-01-01T00:20:00Z'),
			span('mid2', 'mid-roll', '2026-01-01T00:20:00Z', '2026-01-01T00:20:30Z'),
			span('post', 'post-roll', '2026-01-01T00:20:30Z', '2026-01-01T00:21:00Z'),
			span('tail', 'tail', '2026-01-01T00:21:00Z', '2026-01-01T00:22:00Z', ''),
			span('fallback', 'fallback', '2026-01-01T00:22:00Z', '2026-01-01T00:23:00Z', ''),
		];
		const ticks = previewFillerTicks(preview(segments));
		expect(ticks.map(tick => tick.stage)).toEqual(['pre-roll', 'mid-roll', 'mid-roll', 'post-roll', 'tail', 'fallback']);
		expect(ticks[0]!.finish).toBe('2026-01-01T00:00:20.000Z');
		expect(ticks[0]!.width).toBeCloseTo(20 / 86400 * 100, 8);
		expect(ticks[1]!.width).toBeCloseTo(30 / 86400 * 100, 8);
		expect(ticks[1]!.left).toBeCloseTo(10 / 1440 * 100);
	});

	it('covers the full duration of a wide filler break', () => {
		const ticks = previewFillerTicks(preview([
			span('long', 'tail', '2026-01-01T06:00:00Z', '2026-01-01T18:00:00Z', ''),
		]));
		expect(ticks[0]).toMatchObject({ left: 25, width: 50 });
	});

	it('keeps adjacent airings distinct and ignores missing labels and zero-length output', () => {
		const first = span('first', 'pre-roll', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 'first');
		const second = span('second', 'pre-roll', first.finish, '2026-01-01T00:02:00Z', 'second');
		const unlabeled = { ...second, id: 'old', fillerStage: undefined };
		const empty = { ...second, id: 'empty', start: second.finish };
		expect(previewFillerTicks(preview([first, second, unlabeled, empty])).map(tick => tick.id)).toEqual(['first', 'second']);
		expect(previewFillerTicks(null)).toEqual([]);
	});

	it.each([
		['2026-03-08', '2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z', '2026-03-08T19:30:00Z'],
		['2026-11-01', '2026-11-01T07:00:00Z', '2026-11-02T08:00:00Z', '2026-11-01T19:30:00Z'],
	])('clips continued and truncated breaks on the elapsed DST axis for %s', (date, start, finish, middle) => {
		const ticks = previewFillerTicks(preview([
			span('continued', 'mid-roll', new Date(Date.parse(start) - 10000).toISOString(), new Date(Date.parse(start) + 10000).toISOString()),
			span('middle', 'mid-roll', middle, new Date(Date.parse(middle) + 10000).toISOString()),
			span('clipped', 'tail', new Date(Date.parse(finish) - 10000).toISOString(), new Date(Date.parse(finish) + 10000).toISOString(), ''),
		], date, 'America/Los_Angeles'));
		expect(ticks).toHaveLength(3);
		expect(ticks[0]!.left).toBe(0);
		expect(ticks[0]!.start).toBe(new Date(start).toISOString());
		expect(ticks[1]!.left).toBe(50);
		expect(ticks[2]!.finish).toBe(new Date(finish).toISOString());
		for (const tick of ticks) {
			expect(tick.width).toBeCloseTo(10000 / (Date.parse(finish) - Date.parse(start)) * 100, 8);
		}
	});
});
