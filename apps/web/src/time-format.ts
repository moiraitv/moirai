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

/** Format how long an indexed item has been missing without producing a wide status label. */
export function missingSinceLabel(value: string, reference = new Date()): string {
	const elapsedMilliseconds = Math.max(0, reference.getTime() - Date.parse(value));
	const elapsedMinutes = Math.floor(elapsedMilliseconds / 60_000);
	if (elapsedMinutes < 1) {
		return 'Missing just now';
	}

	if (elapsedMinutes < 60) {
		return `Missing for ${elapsedMinutes}m`;
	}

	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) {
		return `Missing for ${elapsedHours}h`;
	}

	const elapsedDays = Math.floor(elapsedHours / 24);
	if (elapsedDays < 7) {
		return `Missing for ${elapsedDays}d`;
	}

	return `Missing since ${new Intl.DateTimeFormat(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	}).format(new Date(value))}`;
}
