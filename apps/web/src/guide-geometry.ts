/** Size a guide segment by elapsed playback time, independent of DST wall-clock changes. */
export function guideSegmentWidth(
	start: string,
	finish: string,
	hourWidth: number,
	minimumWidth = 3,
): number {
	const elapsedHours = (new Date(finish).getTime() - new Date(start).getTime()) / 3_600_000;
	return Math.max(minimumWidth, elapsedHours * hourWidth);
}
