import { Temporal } from '@js-temporal/polyfill';
import { MAX_GUIDE_TIMELINE_SEGMENTS, type GuideEntry } from '@moirai/shared';

/** Signal that even one complete guide day would exceed the bounded entry count. */
export class GuideMaterializationLimitError extends Error {
	constructor(readonly limit: number) {
		super(`Schedule guide exceeds the ${limit.toLocaleString('en-US')} segment limit`);
		this.name = 'GuideMaterializationLimitError';
	}
}

/** Find the last complete local day fitting projected entries across all channel rows. */
export function boundedProjectedWindow(
	start: Temporal.PlainDate,
	end: Temporal.PlainDate,
	timeZone: string,
	entries: GuideEntry[],
	limit = MAX_GUIDE_TIMELINE_SEGMENTS,
) {
	if (entries.length <= limit) {
		return { days: start.until(end, { largestUnit: 'days' }).days, endDate: end, segmentLimitApplied: false };
	}

	const starts = entries.map((entry) => Date.parse(entry.start)).sort((left, right) => left - right);
	const endDate = Temporal.Instant.fromEpochMilliseconds(starts[limit]!).toZonedDateTimeISO(timeZone).toPlainDate();
	const days = start.until(endDate, { largestUnit: 'days' }).days;
	if (days < 1) {
		throw new GuideMaterializationLimitError(limit);
	}
	return { days, endDate, segmentLimitApplied: true };
}
