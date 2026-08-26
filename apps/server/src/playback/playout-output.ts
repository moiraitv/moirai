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

	const segmentDurationSeconds = elapsedMilliseconds(segmentStart, segmentFinish) / 1_000;
	const parts = (segment.playbackParts?.length ?? 0) > 0
		? segment.playbackParts!
		: [{
			playbackPath: segment.playbackPath,
			durationSeconds: Math.max(
				segment.sourceFinishSeconds ?? 0,
				segment.sourceStartSeconds + segmentDurationSeconds,
			),
		}];
	const virtualStart = segment.sourceStartSeconds + elapsedMilliseconds(segmentStart, start) / 1_000;
	const virtualFinish = virtualStart + elapsedMilliseconds(start, finish) / 1_000;
	const output: EtvPlayoutItem[] = [];
	let partStart = 0;
	for (const [index, part] of parts.entries()) {
		const partFinish = partStart + part.durationSeconds;
		const overlapStart = Math.max(virtualStart, partStart);
		const overlapFinish = Math.min(virtualFinish, partFinish);
		if (overlapStart < overlapFinish) {
			const itemStart = start.add({ milliseconds: (overlapStart - virtualStart) * 1_000 });
			const itemFinish = start.add({ milliseconds: (overlapFinish - virtualStart) * 1_000 });
			const inPointMs = (overlapStart - partStart) * 1_000;
			const outPointMs = overlapFinish < partFinish
				|| (parts.length === 1 && segment.sourceFinishSeconds !== null)
				? (overlapFinish - partStart) * 1_000
				: null;
			output.push({
				type: 'local',
				id: `${segment.id}:${date}${parts.length > 1 ? `:${index}` : ''}`,
				start: itemStart.toString(),
				finish: itemFinish.toString(),
				path: part.playbackPath,
				inPointMs: inPointMs === 0 ? null : Math.round(inPointMs),
				outPointMs: outPointMs === null ? null : Math.round(outPointMs),
			});
		}
		partStart = partFinish;
		if (partStart >= virtualFinish) {
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
