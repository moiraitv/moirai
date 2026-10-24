import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { DEFAULT_FILLER_SHORTFALL_WARNING_THRESHOLD_PERCENT, MAX_TIMELINE_SEGMENTS, type FillerBudget, type SelectionStateRecord } from '@moirai/shared';
import { TimelineMaterializationLimitError } from './limits.js';
import { changedStateRecords, selectProgram, type SelectionContext } from './selection.js';
import type { AiringSpan } from './mid-roll.js';
import { assertFillerProgram } from './validation.js';
import { durationMilliseconds } from '@moirai/shared';

/** Sample a reproducible quantity without consuming state during candidate evaluation. */
export function randomFillerCount(minimum: number, maximum: number, identity: string): number {
	const hash = Number.parseInt(createHash('sha256').update(identity).digest('hex').slice(0, 12), 16);
	return minimum + hash % (maximum - minimum + 1);
}
/** Find the next chronological clock boundary, including both instances of a repeated hour. */
export function clockPaddingSeconds(start: string, timeZone: string, minutes: number): number {
	const instant = Temporal.Instant.from(start);
	const local = instant.toZonedDateTimeISO(timeZone);
	if (local.minute % minutes === 0 && local.second === 0 && local.millisecond === 0 && local.microsecond === 0 && local.nanosecond === 0) {
		return 0;
	}
	let candidate = instant.round({ smallestUnit: 'minute', roundingMode: 'ceil' });
	for (let index = 0; index < 180; index += 1) {
		if (candidate.toZonedDateTimeISO(timeZone).minute % minutes === 0) {
			return Number(candidate.epochMilliseconds - instant.epochMilliseconds) / 1_000;
		}
		candidate = candidate.add({ seconds: 60 });
	}
	throw new Error('Unable to resolve filler clock boundary');
}
/** Resolved quantity or duration, retained across tail continuation. */
export interface FillerProgress {
	unit: 'count' | 'seconds'; remaining: number;
	/** Original stage capacity survives continuation into another scheduling day. */
	fullBudgetSeconds?: number;
}
/** Compare resolved roll supply at millisecond precision, without changing budget or selection. */
export function fillerBudgetShortfall(
	initial: FillerProgress,
	remaining: FillerProgress,
	threshold = DEFAULT_FILLER_SHORTFALL_WARNING_THRESHOLD_PERCENT,
): boolean {
	const scale = initial.unit === 'seconds' ? 1_000 : 1;
	const requested = Math.round(initial.remaining * scale);
	const missing = Math.round(remaining.remaining * scale);
	return requested > 0 && (requested - missing) * 100 < requested * threshold;
}

/** Resolve a budget at its actual playback position. */
export function fillerProgress(budget: FillerBudget, start: string, timeZone: string, identity: string, available = 86_400): FillerProgress {
	if (budget.type === 'count') {
		return { unit: 'count', remaining: budget.count };
	}
	if (budget.type === 'random-count') {
		return { unit: 'count', remaining: randomFillerCount(budget.minimum, budget.maximum, identity) };
	}
	return { unit: 'seconds', remaining: budget.type === 'duration' ? budget.seconds
		: budget.type === 'pad' ? clockPaddingSeconds(start, timeZone, budget.minutes) : available };
}
/** Independently select one filler stage while preserving speculative state isolation. */
export function planFiller(
	programId: string,
	budget: FillerBudget,
	sourceState: Map<string, SelectionStateRecord>,
	context: SelectionContext,
	consumerKey: string,
	timeZone: string,
	identity: string,
	available = Infinity,
	progress: FillerProgress | undefined = undefined,
	maxSpans = MAX_TIMELINE_SEGMENTS,
): { spans: AiringSpan[]; state: Map<string, SelectionStateRecord>; durationSeconds: number; initialProgress: FillerProgress; progress: FillerProgress } {
	if (context.programs.get(programId)?.config.type === 'sequence') {
		assertFillerProgram({ programId }, context.programs);
	}
	context.fillerSemanticSources ??= new Map();
	context.candidateIndexes ??= new WeakMap();
	let state = sourceState;
	const spans: AiringSpan[] = [];
	let elapsedMilliseconds = 0;
	const availableMilliseconds = durationMilliseconds(available);
	const stageStartMilliseconds = Date.parse(context.selectionStart);
	const remaining = { ...(progress ?? fillerProgress(budget, context.selectionStart, timeZone, identity, available)) };
	const policy = 'policy' in budget ? budget.policy : 'next-fit-only';
	const allowTruncation = remaining.unit === 'seconds' && (policy === 'best-fit-or-truncate' || policy === 'next-truncate');
	const fullBudgetSeconds = remaining.fullBudgetSeconds ?? (progress && budget.type === 'duration' ? budget.seconds
		: remaining.unit === 'seconds' ? Math.min(remaining.remaining, available) : available);
	if (Number.isFinite(fullBudgetSeconds)) {
		remaining.fullBudgetSeconds = fullBudgetSeconds;
	}
	const initialProgress = { ...remaining };
	let remainingQuantity = remaining.unit === 'seconds' ? durationMilliseconds(remaining.remaining) : remaining.remaining;
	while (remainingQuantity > 0 && elapsedMilliseconds < availableMilliseconds) {
		const capacityMilliseconds = Math.min(availableMilliseconds - elapsedMilliseconds, remaining.unit === 'seconds' ? remainingQuantity : availableMilliseconds);
		const selectionContext = { ...context, mediaDuration: undefined, fillerSelection: { fullBudgetSeconds, allowTruncation },
			selectionStart: new Date(stageStartMilliseconds + elapsedMilliseconds).toISOString() };
		let selected = selectProgram(programId, consumerKey, state, selectionContext, capacityMilliseconds / 1_000, 'first-fit-arbitrary');
		if (!selected && allowTruncation) {
			selected = selectProgram(programId, consumerKey, state, selectionContext);
		}
		if (!selected) {
			break;
		}
		const naturalMilliseconds = durationMilliseconds(selected.media.durationSeconds!);
		if (naturalMilliseconds > capacityMilliseconds && (remaining.unit === 'count' || policy === 'next-fit-only' || policy === 'best-fit-only')) {
			break;
		}
		if (spans.length >= maxSpans) {
			throw new TimelineMaterializationLimitError(MAX_TIMELINE_SEGMENTS);
		}
		const playedMilliseconds = Math.min(naturalMilliseconds, capacityMilliseconds);
		if (playedMilliseconds <= 0) {
			break;
		}
		spans.push({ media: selected.media, role: 'filler', programId, programAncestry: selected.programAncestry,
			sequenceEntryPath: selected.sequenceEntryPath, sourceStartSeconds: 0, sourceFinishSeconds: playedMilliseconds / 1_000,
			truncated: playedMilliseconds < naturalMilliseconds, stateDelta: changedStateRecords(state, selected.state) });
		state = selected.state;
		elapsedMilliseconds += playedMilliseconds;
		remainingQuantity = Math.max(0, remainingQuantity - (remaining.unit === 'count' ? 1 : playedMilliseconds));
	}
	remaining.remaining = remaining.unit === 'seconds' ? remainingQuantity / 1_000 : remainingQuantity;
	return { spans, state, durationSeconds: elapsedMilliseconds / 1_000, initialProgress, progress: remaining };
}
