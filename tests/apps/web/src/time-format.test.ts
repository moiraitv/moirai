import { describe, expect, it } from 'vitest';
import { instantLabel, missingSinceLabel, scheduleClockLabel, scheduleTwelveHourLabel } from '@web/time-format';

describe('time formatting', () => {
	it('formats nominal times with unambiguous morning and afternoon labels', () => {
		expect(scheduleTwelveHourLabel(0)).toBe('12:00 AM');
		expect(scheduleTwelveHourLabel(3_900)).toBe('1:05 AM');
		expect(scheduleTwelveHourLabel(43_200)).toBe('12:00 PM');
		expect(scheduleTwelveHourLabel(65_100)).toBe('6:05 PM');
		expect(scheduleTwelveHourLabel(86_400)).toBe('12:00 AM');
	});

	it('formats schedule seconds and preserves an authored day end when requested', () => {
		expect(scheduleClockLabel(3_900)).toBe('01:05');
		expect(scheduleClockLabel(86_400)).toBe('00:00');
		expect(scheduleClockLabel(86_400, true)).toBe('24:00');
	});

	it('formats an instant in the requested time zone', () => {
		const value = '2026-08-21T01:00:00Z';
		const options: Intl.DateTimeFormatOptions = {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		};
		const expected = new Intl.DateTimeFormat(undefined, {
			...options,
			timeZone: 'America/Los_Angeles',
		}).format(new Date(value));

		expect(instantLabel(value, options, 'America/Los_Angeles')).toBe(expected);
	});

	it('keeps recent missing durations compact before switching to a short date', () => {
		const reference = new Date('2026-08-26T12:00:00.000Z');
		expect(missingSinceLabel('2026-08-26T11:59:30.000Z', reference)).toBe('Missing just now');
		expect(missingSinceLabel('2026-08-26T11:48:00.000Z', reference)).toBe('Missing for 12m');
		expect(missingSinceLabel('2026-08-26T07:00:00.000Z', reference)).toBe('Missing for 5h');
		expect(missingSinceLabel('2026-08-23T12:00:00.000Z', reference)).toBe('Missing for 3d');
		expect(missingSinceLabel('2026-08-19T12:00:00.000Z', reference)).toMatch(/^Missing since /);
	});
});
