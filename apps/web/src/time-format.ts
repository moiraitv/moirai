import { SECONDS_PER_SCHEDULING_DAY } from '@moirai/shared';

/** Format seconds within a schedule day as a 24-hour clock label. */
export function scheduleClockLabel(seconds: number, preserveDayEnd = false): string {
	if (preserveDayEnd && seconds === SECONDS_PER_SCHEDULING_DAY) {
		return '24:00';
	}

	const normalized = seconds % SECONDS_PER_SCHEDULING_DAY;
	const hours = Math.floor(normalized / 3_600);
	const minutes = Math.floor((normalized % 3_600) / 60);

	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Format an instant with caller-owned fields and an optional scheduling time zone. */
export function instantLabel(
	value: string,
	options: Intl.DateTimeFormatOptions,
	timeZone?: string,
): string {
	return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(value));
}
