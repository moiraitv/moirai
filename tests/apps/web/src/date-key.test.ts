import { describe, expect, it } from 'vitest';
import { dateKey, formatDateKey, shiftDateKey } from '@web/date-key';

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
