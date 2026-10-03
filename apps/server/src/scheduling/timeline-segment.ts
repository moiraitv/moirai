import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { TimelineSegment } from '@moirai/shared';

/** Return exact millisecond-backed elapsed seconds between two absolute instants. */
export function durationBetween(start: Temporal.Instant, finish: Temporal.Instant): number {
	return Math.max(0, (finish.epochMilliseconds - start.epochMilliseconds) / 1_000);
}

/** Advance an instant by an elapsed duration while preserving millisecond precision. */
export function plusSeconds(start: Temporal.Instant, seconds: number): Temporal.Instant {
	return start.add({ milliseconds: Math.round(seconds * 1_000) });
}

/** Create a repeatable identifier for one materialized timeline segment. */
export function stableSegmentId(parts: string[]): string {
	const hex = createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** Build one concrete timeline segment from selected media. */
export function segment(
	input: Omit<TimelineSegment, 'id' | 'start' | 'finish'> & {
		start: Temporal.Instant;
		finish: Temporal.Instant;
	},
): TimelineSegment {
	const start = input.start.toString();
	const finish = input.finish.toString();
	return {
		...input,
		id: stableSegmentId([
			input.channelId,
			input.slotId,
			input.role,
			input.mediaItemId ?? 'none',
			start,
		]),
		start,
		finish,
	};
}

