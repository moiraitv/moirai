import { Temporal } from '@js-temporal/polyfill';
import type { SchedulePredicate } from '@moirai/shared';

/** Format a local date as the recurring month-and-day predicate key. */
function monthDayKey(value: { month: number; day: number }): number {
	return value.month * 100 + value.day;
}

/** Evaluate one non-composite scheduling predicate. */
function leafMatches(
	predicate: SchedulePredicate,
	instant: Temporal.Instant,
	anchorDate: Temporal.PlainDate,
	timeZone: string,
): boolean {
	if (predicate.type === 'all' || predicate.type === 'any') {
		throw new Error('Predicate groups must be evaluated before their leaves');
	}

	let matches: boolean;
	switch (predicate.type) {
		case 'months':
			matches = predicate.values.includes(anchorDate.month);
			break;
		case 'weekdays':
			matches = predicate.values.includes(anchorDate.dayOfWeek);
			break;
		case 'dates':
			matches = predicate.values.includes(anchorDate.toString());
			break;
		case 'date-range': {
			const value = anchorDate.toString();
			matches = value >= predicate.startDate && value <= predicate.endDate;
			break;
		}
		case 'annual-range': {
			const value = monthDayKey(anchorDate);
			const start = monthDayKey(predicate.start);
			const end = monthDayKey(predicate.end);
			matches = start <= end ? value >= start && value <= end : value >= start || value <= end;
			break;
		}
		case 'time-range': {
			const localTime = instant.toZonedDateTimeISO(timeZone).toPlainTime();
			const localSeconds = localTime.hour * 3_600 + localTime.minute * 60 + localTime.second;
			matches
				= predicate.endSeconds > predicate.startSeconds
					? localSeconds >= predicate.startSeconds && localSeconds < predicate.endSeconds
					: localSeconds >= predicate.startSeconds || localSeconds < predicate.endSeconds;
			break;
		}
	}
	return predicate.negated ? !matches : matches;
}

/** Matches available under the current date or a proven overnight occurrence date. */
interface PredicateMatchModes {
	current: boolean;
	prior: boolean;
	priorAnchored: boolean;
}

/** Return local seconds elapsed since midnight for one concrete instant. */
function localSeconds(instant: Temporal.Instant, timeZone: string): number {
	const localTime = instant.toZonedDateTimeISO(timeZone).toPlainTime();
	return localTime.hour * 3_600 + localTime.minute * 60 + localTime.second;
}

/** Evaluate both possible occurrence dates without leaking an overnight anchor across `any` branches. */
function evaluateModes(
	predicate: SchedulePredicate,
	instant: Temporal.Instant,
	currentDate: Temporal.PlainDate,
	priorDate: Temporal.PlainDate,
	timeZone: string,
): PredicateMatchModes {
	if (predicate.type === 'all' || predicate.type === 'any') {
		const children = predicate.children.map((child) =>
			evaluateModes(child, instant, currentDate, priorDate, timeZone));
		const combine = predicate.type === 'all'
			? (values: boolean[]): boolean => values.every(Boolean)
			: (values: boolean[]): boolean => values.some(Boolean);
		const current = combine(children.map((child) => child.current));
		const prior = combine(children.map((child) => child.prior));
		return {
			current,
			prior,
			priorAnchored: prior
				&& children.some((child) => child.prior && child.priorAnchored),
		};
	}

	if (
		predicate.type === 'time-range'
		&& !predicate.negated
		&& predicate.endSeconds <= predicate.startSeconds
	) {
		const seconds = localSeconds(instant, timeZone);
		return {
			current: seconds >= predicate.startSeconds,
			prior: seconds < predicate.endSeconds,
			priorAnchored: seconds < predicate.endSeconds,
		};
	}

	return {
		current: leafMatches(predicate, instant, currentDate, timeZone),
		prior: leafMatches(predicate, instant, priorDate, timeZone),
		priorAnchored: false,
	};
}

/** Evaluate a layer predicate at an instant, preserving the start date of overnight occurrences. */
export function schedulePredicateMatches(
	predicate: SchedulePredicate,
	instant: Temporal.Instant,
	timeZone: string,
): boolean {
	const localDate = instant.toZonedDateTimeISO(timeZone).toPlainDate();
	const priorDate = localDate.subtract({ days: 1 });
	const modes = evaluateModes(predicate, instant, localDate, priorDate, timeZone);
	return modes.current || (modes.prior && modes.priorAnchored);
}

/** Return local wall-clock boundaries at which a predicate can change within a day. */
export function predicateTimeBoundaries(predicate: SchedulePredicate): number[] {
	if (predicate.type === 'all' || predicate.type === 'any') {
		return predicate.children.flatMap(predicateTimeBoundaries);
	}

	return predicate.type === 'time-range' ? [predicate.startSeconds, predicate.endSeconds] : [];
}
