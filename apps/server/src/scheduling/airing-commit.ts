import { Temporal } from '@js-temporal/polyfill';
import type { ScheduleTemplate, ScheduleSlot, SelectionStateRecord, TimelineSegment } from '@moirai/shared';
import type { AiringPlan } from './mid-roll.js';
import { changedStateRecords, type SelectionResult } from './selection.js';
import { durationBetween, plusSeconds, segment, stableSegmentId } from './timeline-segment.js';

/** Owned cursor state and output sink receiving only accepted airing spans. */
export interface AiringCommitContext {
	channelId: string;
	state: Map<string, SelectionStateRecord>;
	appendSegment: (segment: TimelineSegment, delta: SelectionStateRecord[]) => void;
}

/** Commit an accepted airing, charging primary state once and filler state only when emitted. */
export function commitAiring(
	context: AiringCommitContext,
	selected: SelectionResult,
	plan: AiringPlan | null,
	start: Temporal.Instant,
	finish: Temporal.Instant,
	template: ScheduleTemplate,
	slot: ScheduleSlot,
	layerId: string | null,
): void {
	const spans = plan?.spans ?? [{ media: selected.media, role: 'primary' as const, programId: slot.programId!,
		sourceStartSeconds: 0, sourceFinishSeconds: selected.media.durationSeconds!, truncated: false, stateDelta: [] }];
	const anchorId = stableSegmentId([context.channelId, slot.id, 'primary', selected.media.id, start.toString()]);
	const grouped = spans.some(span => span.role === 'filler');
	const airing = grouped ? { id: anchorId, start: start.toString(), finish: finish.toString(), primarySegmentId: anchorId,
		truncated: (() => {
			let elapsed = 0;
			let primaryFinish = 0;
			for (const span of spans) {
				elapsed += span.sourceFinishSeconds - span.sourceStartSeconds;
				if (span.role === 'primary') {
					primaryFinish = elapsed;
				}
			}
			return durationBetween(start, finish) < primaryFinish;
		})() } : null;
	let spanStart = start;
	let committedPrimary = false;
	const primaryDelta = changedStateRecords(context.state, selected.state);
	for (const span of spans) {
		if (Temporal.Instant.compare(spanStart, finish) >= 0) {
			break;
		}
		const naturalEnd = plusSeconds(spanStart, span.sourceFinishSeconds - span.sourceStartSeconds);
		const spanEnd = Temporal.Instant.compare(naturalEnd, finish) > 0 ? finish : naturalEnd;
		const entry = segment({ channelId: context.channelId, templateId: template.id, slotId: slot.id,
			scheduleLayerId: layerId, role: span.role, programId: span.programId, mediaItemId: span.media.id,
			title: span.media.title, playbackPath: span.media.playbackPath,
			playbackParts: span.media.playbackParts ?? [{ playbackPath: span.media.playbackPath, durationSeconds: span.media.durationSeconds! }],
			start: spanStart, finish: spanEnd, sourceStartSeconds: span.sourceStartSeconds,
			sourceFinishSeconds: span.sourceStartSeconds + durationBetween(spanStart, spanEnd),
			truncated: span.truncated || Temporal.Instant.compare(spanEnd, naturalEnd) < 0, airing,
			programAncestry: span.role === 'primary' ? selected.programAncestry : span.programAncestry,
			sequenceEntryPath: span.role === 'primary' ? selected.sequenceEntryPath : span.sequenceEntryPath,
		});
		const firstPrimary = span.role === 'primary' && !committedPrimary;
		const delta = firstPrimary ? primaryDelta : span.stateDelta;
		if (firstPrimary) {
			entry.id = anchorId;
			committedPrimary = true;
		}
		context.appendSegment(entry, delta);
		for (const record of delta) {
			context.state.set(record.consumerKey, record);
		}
		spanStart = spanEnd;
	}
}
