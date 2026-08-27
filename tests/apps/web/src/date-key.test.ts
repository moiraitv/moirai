import { describe, expect, it } from 'vitest';
import { dateKey, formatDateKey, shiftCalendarMonths, shiftDateKey } from '@web/date-key';

describe('dateKey', () => {
	it('uses the configured scheduling time zone rather than the browser or UTC date', () => {
		const instant = new Date('2026-08-21T01:00:00Z');
		expect(dateKey(instant, 'America/Los_Angeles')).toBe('2026-08-20');
		expect(dateKey(instant, 'Asia/Tokyo')).toBe('2026-08-21');
	});

	it('shifts date keys across month and year boundaries', () => {
		expect(shiftDateKey('2026-12-31', 1)).toBe('2027-01-01');
		expect(shiftDateKey('2026-03-01', -1)).toBe('2026-02-28');
	});

	it('clamps calendar-month shifts at the target month end', () => {
		expect(shiftCalendarMonths(new Date(2026, 4, 31), -3)).toEqual(new Date(2026, 1, 28));
		expect(shiftCalendarMonths(new Date(2024, 7, 31), -6)).toEqual(new Date(2024, 1, 29));
	});

	it('formats date keys without shifting them into the browser time zone', () => {
		const options: Intl.DateTimeFormatOptions = {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		};
		const expected = new Intl.DateTimeFormat(undefined, {
			...options,
			timeZone: 'UTC',
		}).format(new Date('2026-08-21T12:00:00Z'));

		expect(formatDateKey('2026-08-21', options)).toBe(expected);
	});
});
