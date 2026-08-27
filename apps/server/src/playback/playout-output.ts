import { Temporal } from '@js-temporal/polyfill';
import {
	toEtvPlayout,
	type EtvPlayoutItem,
} from '@moirai/ersatztv-contract';
import type { Channel, ScheduleGuide, TimelineSegment } from '@moirai/shared';

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

/** Generate non-overlapping daily ErsatzTV playout files from the committed guide. */
export function buildEtvPlayoutFiles(
	channels: Channel[],
	guide: ScheduleGuide,
): Map<string, string> {
	const files = new Map<string, string>();
	const segmentsByChannel = new Map(
		guide.channels.map((entry) => [entry.channelId, entry.preview.segments]),
	);
	const firstDate = Temporal.PlainDate.from(guide.startDate);
	for (const channel of channels) {
		const segments = segmentsByChannel.get(channel.id);
		for (let day = 0; day < guide.days; day += 1) {
			const date = firstDate.add({ days: day });
			const nextDate = date.add({ days: 1 });
			const zonedStart = date.toZonedDateTime(guide.timeZone);
			const zonedFinish = nextDate.toZonedDateTime(guide.timeZone);
			const start = zonedStart.toInstant();
			const finish = zonedFinish.toInstant();
			// Leave intentional gaps empty. The pinned worker fills each gap with a
			// fresh, bounded one-minute lavfi item at the current transcode position.
			// Persisting an all-day lavfi item would make the worker seek hours into a
			// synthetic input when a client tunes mid-day, delaying or preventing HLS
			// readiness.
			const items = segments
				? segments.flatMap((segment) => {
					return playoutItems(segment, start, finish, date.toString());
				})
				: [];
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
