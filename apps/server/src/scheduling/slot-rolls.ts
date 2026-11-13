import { durationMilliseconds, type FillerBudget, type SelectionStateRecord } from '@moirai/shared';
import { Temporal } from '@js-temporal/polyfill';
import type { AiringCommitContext } from './airing-commit.js';
import type { SlotOutroReservation, TimelineContinuation } from './continuation.js';
import type { AiringFillerStage } from './filler-assignment.js';
import { fillerBudgetShortfall, planFiller, type FillerProgress } from './filler-plan.js';
import { addIssue, type SelectionContext } from './selection.js';
import type { RecordedTimelineIssue } from './timeline-issues.js';
import { durationBetween, plusSeconds, segment } from './timeline-segment.js';

/** A bounded filler proposal whose diagnostic and cursor changes can be discarded. */
export type SlotFillerPlan = ReturnType<typeof planFiller> & { issues: RecordedTimelineIssue[] };

/** Evaluate a stage without publishing diagnostics until the slot accepts the proposal. */
export function planSlotRoll(
	assignment: AiringFillerStage,
	budget: FillerBudget,
	state: Map<string, SelectionStateRecord>,
	context: SelectionContext,
	start: Temporal.Instant,
	available: number,
	timeZone: string,
	identity: string,
	progress?: FillerProgress,
): SlotFillerPlan {
	const issues: RecordedTimelineIssue[] = [];
	const result = planFiller(assignment.programId, budget, state, {
		...context, selectionStart: start.toString(), issues, issueKeys: new Set(), issueIndex: new Map(),
		blockedPrograms: new Set(context.blockedPrograms),
	}, assignment.consumerKey, timeZone, `${identity}:${assignment.consumerKey}`, available, progress);
	return { ...result, issues };
}

/** Select a concrete closing before admitting primary content, or restore its protected window. */
export function reserveSlotOutro(
	assignment: AiringFillerStage,
	state: Map<string, SelectionStateRecord>,
	context: SelectionContext,
	earliest: Temporal.Instant,
	end: Temporal.Instant,
	timeZone: string,
	identity: string,
	saved: SlotOutroReservation | undefined,
	resumedProgress: FillerProgress | undefined,
): { plan: SlotFillerPlan; reservation: SlotOutroReservation | null } {
	const budget: FillerBudget = assignment.budget.type === 'pad'
		? { type: 'duration', seconds: assignment.budget.minutes * 60, policy: assignment.budget.policy }
		: assignment.budget;
	const withoutCollisions = { ...context, avoidCrossChannelDuplicates: false };

	if (saved) {
		const reservedStart = Temporal.Instant.from(saved.start);
		const elapsed = durationBetween(reservedStart, earliest);
		const start = plusSeconds(Temporal.Instant.from(saved.selectionStart), elapsed);
		const available = Math.max(0, durationBetween(reservedStart, end) - elapsed);
		const progress = resumedProgress ?? saved.progress;
		const plan = planSlotRoll(
			assignment,
			budget,
			state,
			saved.ignoreCollisions ? withoutCollisions : context,
			start,
			available,
			timeZone,
			identity,
			progress,
		);
		if (!saved.ignoreCollisions && context.avoidCrossChannelDuplicates !== false
			&& context.occupiedMedia.length > 0 && plan.durationSeconds < available) {
			const fallback = planSlotRoll(assignment, budget, state, withoutCollisions, start, available, timeZone, identity, progress);
			if (fallback.durationSeconds > plan.durationSeconds) {
				return { plan: fallback, reservation: { ...saved, ignoreCollisions: true } };
			}
		}
		return { plan, reservation: saved };
	}

	// Measure a playable closing before checking overlap in its end-aligned window.
	const available = durationBetween(earliest, end);
	let plan = planSlotRoll(assignment, budget, state, withoutCollisions, earliest, available, timeZone, identity);
	const start = end.subtract({ milliseconds: durationMilliseconds(plan.durationSeconds) });
	let ignoreCollisions = true;
	if (plan.durationSeconds > 0 && context.avoidCrossChannelDuplicates !== false && context.occupiedMedia.length > 0) {
		const refined = planSlotRoll(
			assignment,
			budget,
			state,
			context,
			start,
			plan.durationSeconds,
			timeZone,
			identity,
			plan.initialProgress,
		);
		if (refined.durationSeconds === plan.durationSeconds) {
			plan = refined;
			ignoreCollisions = false;
		}
	}
	const reservation = plan.durationSeconds > 0
		? { start: start.toString(), selectionStart: start.toString(), progress: plan.initialProgress,
			...(ignoreCollisions ? { ignoreCollisions: true as const } : {}) }
		: null;
	return { plan, reservation };
}

/** Publish diagnostics only for the chosen plan, attributing a shortfall to its slot and stage. */
export function reportSlotRoll(
	context: SelectionContext,
	plan: SlotFillerPlan,
	assignment: AiringFillerStage,
	stage: 'pre-roll' | 'post-roll',
	start: Temporal.Instant,
): void {
	for (const issue of plan.issues) {
		for (const occurrence of issue.occurrences ?? []) {
			addIssue(context, { ...issue, occurrence: { ...occurrence, start: start.toString() } });
		}
	}
	if (fillerBudgetShortfall(plan.initialProgress, plan.progress, context.fillerShortfallWarningThresholdPercent)) {
		addIssue(context, {
			code: 'slot-roll-shortfall', message: `Once-per-slot ${stage} could not supply the requested filler budget.`,
			programId: assignment.programId, mediaItemId: null,
			occurrence: { start: start.toString(), finish: null, boundaryOrigin: context.boundaryOrigin },
		});
	}
}

/** Emit standalone filler and checkpoint each clip's progress with its own state delta. */
export function commitStandaloneFiller(
	context: AiringCommitContext,
	continuation: TimelineContinuation,
	phase: 'intro' | 'outro' | 'tail' | 'fallback',
	presetId: string | undefined,
	plan: ReturnType<typeof planFiller>,
	cursor: Temporal.Instant,
	windowEnd: Temporal.Instant,
): Temporal.Instant {
	continuation.phase = phase;
	const progress = { ...plan.initialProgress };
	continuation.fillerProgress = progress;
	for (const span of plan.spans) {
		if (Temporal.Instant.compare(cursor, windowEnd) >= 0) {
			break;
		}

		const finish = plusSeconds(cursor, span.sourceFinishSeconds);
		progress.remaining = progress.unit === 'count' ? progress.remaining - 1
			: Math.max(0, durationMilliseconds(progress.remaining) - durationMilliseconds(span.sourceFinishSeconds)) / 1_000;
		continuation.fillerProgress = { ...progress };
		context.appendSegment(segment({
			role: 'filler', fillerStage: phase === 'intro' ? 'pre-roll' : phase === 'outro' ? 'post-roll' : phase,
			fillerPresetId: presetId, channelId: context.channelId, scheduleLayerId: continuation.scheduleLayerId,
			templateId: continuation.templateId, slotId: continuation.slotId, programId: span.programId,
			mediaItemId: span.media.id, title: span.media.title, playbackPath: span.media.playbackPath,
			playbackParts: span.media.playbackParts ?? [{ playbackPath: span.media.playbackPath, durationSeconds: span.media.durationSeconds! }],
			start: cursor, finish, sourceStartSeconds: 0, sourceFinishSeconds: span.sourceFinishSeconds,
			truncated: span.truncated, programAncestry: span.programAncestry, sequenceEntryPath: span.sequenceEntryPath,
		}), span.stateDelta);
		for (const record of span.stateDelta) {
			context.state.set(record.consumerKey, record);
		}
		cursor = finish;
	}
	return cursor;
}
