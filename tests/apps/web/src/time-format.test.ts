import { describe, expect, it } from 'vitest';
import { instantLabel, scheduleClockLabel } from '@web/time-format';

describe('time formatting', () => {
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
});
