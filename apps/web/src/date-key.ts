/** Format an instant as the configured scheduling calendar date. */
export function dateKey(date: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(date);

	const part = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((entry) => entry.type === type)?.value ?? '';

	return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Shift an ISO calendar date without applying the browser's local time zone. */
export function shiftDateKey(value: string, amount: number): string {
	const [year, month, day] = value.split('-').map(Number);
	const shifted = new Date(Date.UTC(year!, month! - 1, day! + amount));

	return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()]
		.map((part, index) => String(part).padStart(index ? 2 : 4, '0'))
		.join('-');
}

/** Count whole calendar days between two ISO date keys without local-zone conversion. */
export function calendarDateSpan(start: string, end: string): number {
	const [startYear, startMonth, startDay] = start.split('-').map(Number);
	const [endYear, endMonth, endDay] = end.split('-').map(Number);
	const startTime = Date.UTC(startYear!, startMonth! - 1, startDay!);
	const endTime = Date.UTC(endYear!, endMonth! - 1, endDay!);

	return Math.round((endTime - startTime) / 86_400_000);
}

/** Shift a local date by calendar months while clamping month-end overflow. */
export function shiftCalendarMonths(value: Date, amount: number): Date {
	const shifted = new Date(value);
	const desiredDay = shifted.getDate();
	shifted.setDate(1);
	shifted.setMonth(shifted.getMonth() + amount);
	const finalDay = new Date(
		shifted.getFullYear(),
		shifted.getMonth() + 1,
		0,
	).getDate();
	shifted.setDate(Math.min(desiredDay, finalDay));
	return shifted;
}

/** Format an ISO calendar date without allowing a local-zone day shift. */
export function formatDateKey(
	value: string,
	options: Intl.DateTimeFormatOptions,
): string {
	const [year, month, day] = value.split('-').map(Number);

	return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(
		new Date(Date.UTC(year!, month! - 1, day!, 12)),
	);
}
