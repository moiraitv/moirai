import { describe, expect, it } from 'vitest';
import { guideSegmentWidth } from '@web/guide-geometry';

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
});
