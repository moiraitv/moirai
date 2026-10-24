import { describe, expect, it } from 'vitest';
import { compareInstants, durationMilliseconds, spanDurationMilliseconds, timestampBoundaryMilliseconds,
	MAX_MEDIA_DURATION_MILLISECONDS } from '@moirai/shared';

describe('shared millisecond time math', () => {
	it('round-trips measured durations without float accumulation or losing unbounded budgets', () => {
		for (const milliseconds of [1, 2, 3, 100, 1_005, 10_002, 27_998, 32_002, 40_102, MAX_MEDIA_DURATION_MILLISECONDS]) {
			expect(durationMilliseconds(milliseconds / 1_000)).toBe(milliseconds);
		}
		expect(durationMilliseconds(30.1 + 10.002)).toBe(40_102);
		expect(durationMilliseconds(60 - 32.002)).toBe(27_998);
		expect(durationMilliseconds(Infinity)).toBe(Infinity);
		expect(spanDurationMilliseconds(30.1, 40.102)).toBe(10_002);
	});

	it('orders offset and mixed-precision instants with exact half-open boundaries', () => {
		const midnight = '2026-01-06T00:00:00Z';
		for (const equivalent of ['2026-01-06T00:00:00.000Z', '2026-01-06T01:00:00+01:00', '2026-01-05T19:00:00-05:00']) {
			expect(compareInstants(midnight, equivalent)).toBe(0);
		}
		expect(compareInstants('2026-01-05T23:59:59.999Z', midnight)).toBe(-1);
		expect(compareInstants('2026-01-06T00:00:00.001Z', midnight)).toBe(1);
	});

	it('preserves finer filter bounds even before the epoch or with more than nine fractional digits', () => {
		for (const value of ['1969-12-31T23:59:59.9991Z', '1970-01-01T00:59:59.9991+01:00', '1969-12-31T18:59:59.9990000000001-05:00']) {
			expect(timestampBoundaryMilliseconds(value)).toBe(0);
		}
		expect(timestampBoundaryMilliseconds('1969-12-31T23:59:59.999000000000Z')).toBe(-1);
		expect(timestampBoundaryMilliseconds('1970-01-01T00:00:00.0000000000001Z')).toBe(1);
	});
});
