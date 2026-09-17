import { Temporal } from '@js-temporal/polyfill';

/** Milliseconds in one elapsed hour used to convert guide instants into pixels. */
const MILLISECONDS_PER_HOUR = 3_600_000;

/** One wall-clock ruler mark positioned on the guide's elapsed-time axis. */
export interface GuideHourTick {
	hour: number;
	left: number;
}

/** Local calendar day with its actual elapsed width and wall-clock ruler marks. */
export interface GuideDayGeometry {
	key: string;
	startMilliseconds: number;
	finishMilliseconds: number;
	left: number;
	width: number;
	ticks: GuideHourTick[];
}

/** Build consecutive local days on one elapsed-time axis, preserving DST-short or DST-long days. */
export function guideDayGeometry(
	startDate: string,
	days: number,
	timeZone: string,
	hourWidth: number,
): GuideDayGeometry[] {
	const firstDate = Temporal.PlainDate.from(startDate);
	const output: GuideDayGeometry[] = [];
	let left = 0;
	for (let index = 0; index < days; index += 1) {
		const date = firstDate.add({ days: index });
		const start = date.toZonedDateTime(timeZone).toInstant();
		const finish = date.add({ days: 1 }).toZonedDateTime(timeZone).toInstant();
		const startMilliseconds = start.epochMilliseconds;
		const finishMilliseconds = finish.epochMilliseconds;
		const width = (finishMilliseconds - startMilliseconds) / MILLISECONDS_PER_HOUR * hourWidth;
		const ticks = Array.from({ length: 12 }, (_, tickIndex) => tickIndex * 2).flatMap(
			(hour) => {
				const zoned = date.toPlainDateTime({ hour }).toZonedDateTime(
					timeZone,
					{ disambiguation: 'compatible' },
				);
				if (zoned.hour !== hour) {
					return [];
				}

				return [{
					hour,
					left: (zoned.toInstant().epochMilliseconds - startMilliseconds)
						/ MILLISECONDS_PER_HOUR * hourWidth,
				}];
			},
		);
		output.push({
			key: date.toString(),
			startMilliseconds,
			finishMilliseconds,
			left,
			width,
			ticks,
		});
		left += width;
	}

	return output;
}

/** Return the complete elapsed width represented by a local-day guide window. */
export function guideWindowMilliseconds(startDate: string, days: number, timeZone: string): number {
	const geometry = guideDayGeometry(startDate, days, timeZone, 1);
	return geometry.length === 0
		? 0
		: geometry.at(-1)!.finishMilliseconds - geometry[0]!.startMilliseconds;
}

/** Position an instant on a previously resolved elapsed-time guide axis. */
export function guideInstantPosition(
	value: string,
	days: GuideDayGeometry[],
	hourWidth: number,
): number {
	if (days.length === 0) {
		return 0;
	}

	const elapsedMilliseconds = Date.parse(value) - days[0]!.startMilliseconds;
	const totalWidth = days.at(-1)!.left + days.at(-1)!.width;
	return Math.max(
		0,
		Math.min(totalWidth, elapsedMilliseconds / MILLISECONDS_PER_HOUR * hourWidth),
	);
}

/** Size a guide segment by elapsed playback time, independent of DST wall-clock changes. */
export function guideSegmentWidth(
	start: string,
	finish: string,
	hourWidth: number,
	minimumWidth = 3,
): number {
	const elapsedHours = (new Date(finish).getTime() - new Date(start).getTime())
		/ MILLISECONDS_PER_HOUR;
	return Math.max(minimumWidth, elapsedHours * hourWidth);
}

/** Return whether an absolutely positioned programme overlaps a pixel window on the guide axis. */
export function guideSpanOverlapsRange(
	left: number,
	right: number,
	rangeStart: number,
	rangeEnd: number,
): boolean {
	return left < rangeEnd && right > rangeStart;
}

/** Keep programmes whose elapsed-time span intersects a visible pixel window. */
export function guideProgrammesInPixelRange<T extends { start: string; finish: string }>(
	programmes: readonly T[],
	days: GuideDayGeometry[],
	hourWidth: number,
	rangeStart: number,
	rangeEnd: number,
): T[] {
	if (programmes.length === 0 || rangeEnd <= rangeStart) {
		return [];
	}

	return programmes.filter((programme) => {
		const left = guideInstantPosition(programme.start, days, hourWidth);
		const right = left + guideSegmentWidth(programme.start, programme.finish, hourWidth);
		return guideSpanOverlapsRange(left, right, rangeStart, rangeEnd);
	});
}

/** Size one resolved-preview segment against its actual local-day window. */
export function guideSegmentPercent(
	start: string,
	finish: string,
	windowMilliseconds: number,
	minimumPercent = 0.3,
): number {
	if (windowMilliseconds <= 0) {
		return minimumPercent;
	}

	return Math.max(
		minimumPercent,
		(Date.parse(finish) - Date.parse(start)) / windowMilliseconds * 100,
	);
}
