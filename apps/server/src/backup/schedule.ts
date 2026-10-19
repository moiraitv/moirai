import { Temporal } from '@js-temporal/polyfill';

/** Resolve the earliest valid local instant at or after 03:00 on one calendar date. */
function scheduledTime(date: Temporal.PlainDate, timeZone: string): Temporal.ZonedDateTime {
	const requested = date.toPlainDateTime('03:00');
	const candidate = date.toZonedDateTime({ timeZone, plainTime: '03:00' });
	if (Temporal.PlainDateTime.compare(candidate.toPlainDateTime(), requested) > 0) {
		const transition = candidate.getTimeZoneTransition('previous');
		if (transition && Temporal.PlainDateTime.compare(transition.toPlainDateTime(), requested) >= 0) {
			return transition;
		}
	}
	return candidate;
}

/** Find the next local 03:00, resolving gaps forward and overlaps to their first occurrence. */
export function nextBackupRun(now: string, timeZone: string, intervalDays = 1, previous?: string): string {
	const instant = Temporal.Instant.from(now);
	let date = previous
		? Temporal.Instant.from(previous).toZonedDateTimeISO(timeZone).toPlainDate().add({ days: intervalDays })
		: instant.toZonedDateTimeISO(timeZone).toPlainDate();
	let candidate = scheduledTime(date, timeZone);
	if (Temporal.Instant.compare(candidate.toInstant(), instant) <= 0) {
		// Jump over missed intervals without replaying missed work or iterating thousands of days.
		const today = instant.toZonedDateTimeISO(timeZone).toPlainDate();
		const elapsed = date.until(today, { largestUnit: 'days' }).days;
		date = date.add({ days: Math.max(0, Math.floor(elapsed / intervalDays)) * intervalDays });
		candidate = scheduledTime(date, timeZone);
		if (Temporal.Instant.compare(candidate.toInstant(), instant) <= 0) {
			candidate = scheduledTime(date.add({ days: intervalDays }), timeZone);
		}
	}
	return candidate.toInstant().toString();
}
