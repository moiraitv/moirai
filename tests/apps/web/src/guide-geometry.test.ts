import { describe, expect, it } from 'vitest';
import {
	guideDayGeometry,
	guideInstantPosition,
	guideSegmentPercent,
	guideSegmentWidth,
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
});
