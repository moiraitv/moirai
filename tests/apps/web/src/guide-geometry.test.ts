import { describe, expect, it } from 'vitest';
import {
	guideDayGeometry,
	guideInstantPosition,
	guideProgrammesInPixelRange,
	guideSegmentPercent,
	guideSegmentWidth,
	guideSpanOverlapsRange,
	guideWindowMilliseconds,
} from '@web/guide-geometry';

const HOUR_WIDTH = 56;

describe('guide geometry', () => {
	it('uses elapsed instants across both daylight-saving transitions', () => {
		expect(
			guideSegmentWidth('2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z', HOUR_WIDTH),
		).toBe(HOUR_WIDTH);
		expect(
			guideSegmentWidth('2026-03-08T09:30:00.000Z', '2026-03-08T10:30:00.000Z', HOUR_WIDTH),
		).toBe(HOUR_WIDTH);
	});

	it('aligns segments and day boundaries across daylight-saving transitions', () => {
		const fallDays = guideDayGeometry('2026-11-01', 1, 'America/Los_Angeles', HOUR_WIDTH);
		const springDays = guideDayGeometry('2026-03-08', 1, 'America/Los_Angeles', HOUR_WIDTH);

		expect(fallDays[0]!.width).toBe(25 * HOUR_WIDTH);
		expect(springDays[0]!.width).toBe(23 * HOUR_WIDTH);
		expect(guideInstantPosition('2026-11-01T10:00:00Z', fallDays, HOUR_WIDTH)).toBe(
			guideSegmentWidth('2026-11-01T07:00:00Z', '2026-11-01T10:00:00Z', HOUR_WIDTH),
		);
		expect(guideInstantPosition('2026-03-08T10:00:00Z', springDays, HOUR_WIDTH)).toBe(
			guideSegmentWidth('2026-03-08T08:00:00Z', '2026-03-08T10:00:00Z', HOUR_WIDTH),
		);
	});

	it('sizes compact preview segments against the actual local-day duration', () => {
		const windowMilliseconds = guideWindowMilliseconds(
			'2026-11-01',
			1,
			'America/Los_Angeles',
		);

		expect(windowMilliseconds).toBe(25 * 3_600_000);
		expect(guideSegmentPercent(
			'2026-11-01T07:00:00Z',
			'2026-11-01T10:00:00Z',
			windowMilliseconds,
		)).toBe(12);
	});

	it('keeps programmes that overlap a visible pixel window', () => {
		const days = guideDayGeometry('2026-08-01', 2, 'UTC', HOUR_WIDTH);
		const programmes = [
			{ id: 'before', start: '2026-08-01T00:00:00Z', finish: '2026-08-01T01:00:00Z' },
			{ id: 'visible', start: '2026-08-01T10:00:00Z', finish: '2026-08-01T12:00:00Z' },
			{ id: 'after', start: '2026-08-02T12:00:00Z', finish: '2026-08-02T14:00:00Z' },
		];
		const start = guideInstantPosition('2026-08-01T09:00:00Z', days, HOUR_WIDTH);
		const end = guideInstantPosition('2026-08-01T13:00:00Z', days, HOUR_WIDTH);

		expect(guideSpanOverlapsRange(0, 10, 10, 20)).toBe(false);
		expect(guideProgrammesInPixelRange(programmes, days, HOUR_WIDTH, start, end)
			.map((programme) => programme.id)).toEqual(['visible']);
	});
});
