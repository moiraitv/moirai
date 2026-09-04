import { Temporal } from '@js-temporal/polyfill';
import {
	toEtvPlayout,
	type EtvPlayoutItem,
} from '@moirai/ersatztv-contract';
import {
	FALLBACK_FILLER_MIN_DURATION_MILLISECONDS,
	type Channel,
	type ScheduleGuide,
	type TimelineSegment,
} from '@moirai/shared';

/** Maximum source span exposed through one fallback playout item. */
export const FALLBACK_ITEM_MAX_MILLISECONDS = 5 * 60 * 1_000;

/** Effective fallback selected for one channel. */
export interface PlayoutFallback {
	path: string;
	durationMilliseconds: number;
	hasAudio: boolean;
}

/** Concrete interval covered by scheduled media before fallback insertion. */
interface CoveredInterval {
	start: Temporal.Instant;
	finish: Temporal.Instant;
}

/** Pad a non-negative date or time component for a compact ISO timestamp. */
function padded(value: number, length = 2): string {
	return String(value).padStart(length, '0');
}

/** Format a zoned boundary using ErsatzTV's separator-free playout filename convention. */
export function compactPlayoutTimestamp(value: Temporal.ZonedDateTime): string {
	const fraction = `${padded(value.millisecond, 3)}${padded(value.microsecond, 3)}${padded(value.nanosecond, 3)}`;
	return `${padded(value.year, 4)}${padded(value.month)}${padded(value.day)}T${padded(value.hour)}${padded(value.minute)}${padded(value.second)}.${fraction}${value.offset.replace(':', '')}`;
}

/** Return elapsed milliseconds between two concrete instants. */
function elapsedMilliseconds(start: Temporal.Instant, finish: Temporal.Instant): number {
	return finish.since(start).total({ unit: 'milliseconds' });
}

/** Clip one materialized segment to a daily window and expand its physical playback parts. */
function playoutItems(
	segment: TimelineSegment,
	windowStart: Temporal.Instant,
	windowEnd: Temporal.Instant,
	date: string,
): EtvPlayoutItem[] {
	const segmentStart = Temporal.Instant.from(segment.start);
	const segmentFinish = Temporal.Instant.from(segment.finish);
	const start = Temporal.Instant.compare(segmentStart, windowStart) < 0 ? windowStart : segmentStart;
	const finish = Temporal.Instant.compare(segmentFinish, windowEnd) > 0 ? windowEnd : segmentFinish;
	if (Temporal.Instant.compare(start, finish) >= 0) {
		return [];
	}

	if (segment.role === 'dead-air' || !segment.playbackPath) {
		return [];
	}

	const segmentDurationMs = Math.round(elapsedMilliseconds(segmentStart, segmentFinish));
	const sourceStartMs = Math.round(segment.sourceStartSeconds * 1_000);
	const parts = (segment.playbackParts?.length ?? 0) > 0
		? segment.playbackParts!.map((part) => ({
			playbackPath: part.playbackPath,
			durationMs: Math.round(part.durationSeconds * 1_000),
		}))
		: [{
			playbackPath: segment.playbackPath,
			durationMs: Math.max(
				Math.round((segment.sourceFinishSeconds ?? 0) * 1_000),
				sourceStartMs + segmentDurationMs,
			),
		}];
	const virtualStartMs = sourceStartMs + Math.round(elapsedMilliseconds(segmentStart, start));
	const virtualFinishMs = virtualStartMs + Math.round(elapsedMilliseconds(start, finish));
	const output: EtvPlayoutItem[] = [];
	let partStartMs = 0;
	for (const [index, part] of parts.entries()) {
		const partFinishMs = partStartMs + part.durationMs;
		const overlapStartMs = Math.max(virtualStartMs, partStartMs);
		const overlapFinishMs = Math.min(virtualFinishMs, partFinishMs);
		if (overlapStartMs < overlapFinishMs) {
			const itemStartOffsetMs = overlapStartMs - virtualStartMs;
			const itemFinishOffsetMs = overlapFinishMs - virtualStartMs;
			const itemStart = start.add({ milliseconds: itemStartOffsetMs });
			const itemFinish = start.add({ milliseconds: itemFinishOffsetMs });
			const inPointMs = overlapStartMs - partStartMs;
			const outPointMs = overlapFinishMs < partFinishMs
				|| (parts.length === 1 && segment.sourceFinishSeconds !== null)
				? overlapFinishMs - partStartMs
				: null;
			output.push({
				type: 'local',
				id: `${segment.id}:${date}${parts.length > 1 ? `:${index}` : ''}`,
				start: itemStart.toString(),
				finish: itemFinish.toString(),
				path: part.playbackPath,
				inPointMs: inPointMs === 0 ? null : inPointMs,
				outPointMs,
			});
		}
		partStartMs = partFinishMs;
		if (partStartMs >= virtualFinishMs) {
			break;
		}
	}
	return output;
}

/** Merge scheduled intervals so their complement can be filled without overlaps. */
function coveredIntervals(
	segments: TimelineSegment[],
	windowStart: Temporal.Instant,
	windowEnd: Temporal.Instant,
	date: string,
): CoveredInterval[] {
	const intervals = segments
		.flatMap((segment) => playoutItems(segment, windowStart, windowEnd, date))
		.map<CoveredInterval>((item) => ({
			start: Temporal.Instant.from(item.start),
			finish: Temporal.Instant.from(item.finish),
		}))
		.sort((left, right) => Temporal.Instant.compare(left.start, right.start));
	const merged: CoveredInterval[] = [];
	for (const interval of intervals) {
		const prior = merged.at(-1);
		if (prior && Temporal.Instant.compare(interval.start, prior.finish) <= 0) {
			if (Temporal.Instant.compare(interval.finish, prior.finish) > 0) {
				prior.finish = interval.finish;
			}
			continue;
		}
		merged.push({ ...interval });
	}
	return merged;
}

/** Return every continuous interval not occupied by scheduled playable media. */
function uncoveredIntervals(
	covered: CoveredInterval[],
	windowStart: Temporal.Instant,
	windowEnd: Temporal.Instant,
): CoveredInterval[] {
	const gaps: CoveredInterval[] = [];
	let cursor = windowStart;
	for (const interval of covered) {
		if (Temporal.Instant.compare(cursor, interval.start) < 0) {
			gaps.push({ start: cursor, finish: interval.start });
		}
		if (Temporal.Instant.compare(interval.finish, cursor) > 0) {
			cursor = interval.finish;
		}
	}
	if (Temporal.Instant.compare(cursor, windowEnd) < 0) {
		gaps.push({ start: cursor, finish: windowEnd });
	}
	return gaps;
}

/** Derive a stable loop anchor from materialized dead air or the fixed epoch for an empty guide. */
function fallbackOffset(
	gap: CoveredInterval,
	segments: TimelineSegment[],
	durationMilliseconds: number,
): number {
	const anchors = segments
		.filter((segment) => segment.role === 'dead-air' || !segment.playbackPath)
		.filter((segment) => {
			const start = Temporal.Instant.from(segment.start);
			const finish = Temporal.Instant.from(segment.finish);
			return Temporal.Instant.compare(start, gap.finish) < 0
				&& Temporal.Instant.compare(finish, gap.start) > 0;
		})
		.map((segment) => Temporal.Instant.from(segment.start))
		.sort(Temporal.Instant.compare);
	const anchor = anchors[0];
	if (!anchor && segments.length > 0) {
		return 0;
	}

	const sourceAnchor = anchor ?? Temporal.Instant.fromEpochMilliseconds(0);
	const elapsed = Math.max(0, Math.round(elapsedMilliseconds(sourceAnchor, gap.start)));
	return elapsed % durationMilliseconds;
}

/** Loop or truncate one fallback source to cover a continuous uncovered interval exactly. */
function fallbackItems(
	gap: CoveredInterval,
	fallback: PlayoutFallback,
	initialSourceOffsetMs = 0,
): EtvPlayoutItem[] {
	if (
		!Number.isSafeInteger(fallback.durationMilliseconds)
		|| fallback.durationMilliseconds < FALLBACK_FILLER_MIN_DURATION_MILLISECONDS
	) {
		throw new Error('Fallback filler must have a measured duration of at least 1 minute');
	}
	if (
		!Number.isSafeInteger(initialSourceOffsetMs)
		|| initialSourceOffsetMs < 0
		|| initialSourceOffsetMs >= fallback.durationMilliseconds
	) {
		throw new Error('Fallback filler source offset is outside its measured duration');
	}
	const output: EtvPlayoutItem[] = [];
	let cursor = gap.start;
	let sourceOffsetMs = initialSourceOffsetMs;
	while (Temporal.Instant.compare(cursor, gap.finish) < 0) {
		const gapRemainingMs = Math.round(elapsedMilliseconds(cursor, gap.finish));
		const sourceRemainingMs = fallback.durationMilliseconds - sourceOffsetMs;
		const durationMs = Math.min(
			gapRemainingMs,
			sourceRemainingMs,
			FALLBACK_ITEM_MAX_MILLISECONDS,
		);
		if (durationMs <= 0) {
			throw new Error('Fallback filler could not advance through an uncovered interval');
		}
		const finish = cursor.add({ milliseconds: durationMs });
		const sourceFinishMs = sourceOffsetMs + durationMs;
		output.push({
			type: 'local',
			id: `fallback:${cursor.epochMilliseconds}`,
			start: cursor.toString(),
			finish: finish.toString(),
			path: fallback.path,
			inPointMs: sourceOffsetMs === 0 ? null : sourceOffsetMs,
			outPointMs: sourceFinishMs,
			silentAudio: !fallback.hasAudio,
		});
		cursor = finish;
		sourceOffsetMs = sourceFinishMs === fallback.durationMilliseconds ? 0 : sourceFinishMs;
	}
	return output;
}
/** Clip one generated fallback item to a local-day document while retaining source phase. */
function clipFallbackItem(
	item: EtvPlayoutItem,
	windowStart: Temporal.Instant,
	windowEnd: Temporal.Instant,
): EtvPlayoutItem[] {
	if (item.type !== 'local') {
		return [];
	}
	const itemStart = Temporal.Instant.from(item.start);
	const itemFinish = Temporal.Instant.from(item.finish);
	const start = Temporal.Instant.compare(itemStart, windowStart) < 0 ? windowStart : itemStart;
	const finish = Temporal.Instant.compare(itemFinish, windowEnd) > 0 ? windowEnd : itemFinish;
	if (Temporal.Instant.compare(start, finish) >= 0) {
		return [];
	}
	const sourceStart = (item.inPointMs ?? 0) + Math.round(elapsedMilliseconds(itemStart, start));
	const sourceFinish = sourceStart + Math.round(elapsedMilliseconds(start, finish));
	return [{
		...item,
		id: `fallback:${start.epochMilliseconds}`,
		start: start.toString(),
		finish: finish.toString(),
		inPointMs: sourceStart === 0 ? null : sourceStart,
		outPointMs: sourceFinish,
	}];
}

/** Reject incomplete or overlapping daily output before it can replace the last valid playout. */
function assertCompleteWindow(
	items: EtvPlayoutItem[],
	windowStart: Temporal.Instant,
	windowEnd: Temporal.Instant,
): void {
	let cursor = windowStart;
	for (const item of items) {
		const start = Temporal.Instant.from(item.start);
		const finish = Temporal.Instant.from(item.finish);
		if (Temporal.Instant.compare(start, cursor) !== 0 || Temporal.Instant.compare(finish, start) <= 0) {
			throw new Error('Generated fallback playout is incomplete or overlapping');
		}
		cursor = finish;
	}
	if (Temporal.Instant.compare(cursor, windowEnd) !== 0) {
		throw new Error('Generated fallback playout does not cover the complete local day');
	}
}

/** Generate non-overlapping daily ErsatzTV playout files from the committed guide. */
export function buildEtvPlayoutFiles(
	channels: Channel[],
	guide: ScheduleGuide,
	fallbacks: ReadonlyMap<string, PlayoutFallback> = new Map(),
): Map<string, string> {
	const files = new Map<string, string>();
	const segmentsByChannel = new Map(
		guide.channels.map((entry) => [entry.channelId, entry.preview.segments]),
	);
	const firstDate = Temporal.PlainDate.from(guide.startDate);
	for (const channel of channels) {
		const segments = segmentsByChannel.get(channel.id) ?? [];
		const rangeStart = firstDate.toZonedDateTime(guide.timeZone).toInstant();
		const rangeFinish = firstDate
			.add({ days: guide.days })
			.toZonedDateTime(guide.timeZone)
			.toInstant();
		const fallback = fallbacks.get(channel.id);
		const generatedFallback = fallback
			? uncoveredIntervals(
				coveredIntervals(segments, rangeStart, rangeFinish, guide.startDate),
				rangeStart,
				rangeFinish,
			).flatMap((gap) => fallbackItems(
				gap,
				fallback,
				fallbackOffset(
					gap,
					segments,
					fallback.durationMilliseconds,
				),
			))
			: [];
		for (let day = 0; day < guide.days; day += 1) {
			const date = firstDate.add({ days: day });
			const nextDate = date.add({ days: 1 });
			const zonedStart = date.toZonedDateTime(guide.timeZone);
			const zonedFinish = nextDate.toZonedDateTime(guide.timeZone);
			const start = zonedStart.toInstant();
			const finish = zonedFinish.toInstant();
			const items = [
				...segments.flatMap((segment) => {
					return playoutItems(segment, start, finish, date.toString());
				}),
				...generatedFallback.flatMap((item) => {
					return clipFallbackItem(item, start, finish);
				}),
			].sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
			if (fallback) {
				assertCompleteWindow(items, start, finish);
			}
			const document = toEtvPlayout(items);
			const filename = `${compactPlayoutTimestamp(zonedStart)}_${compactPlayoutTimestamp(zonedFinish)}.json`;
			files.set(
				`channels/${channel.number}/playout/${filename}`,
				`${JSON.stringify(document, null, 2)}\n`,
			);
		}
	}
	return files;
}
