import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { MAX_TIMELINE_SEGMENTS, type FillerBudget, type SelectionStateRecord } from '@moirai/shared';
import { TimelineMaterializationLimitError } from './limits.js';
import { changedStateRecords, selectProgram, type SelectionContext } from './selection.js';
import type { AiringSpan } from './mid-roll.js';
import { assertFillerProgram } from './validation.js';

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
	let durationSeconds = 0;
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
	while (remaining.remaining > 0 && durationSeconds < available) {
		const capacity = Math.min(available - durationSeconds, remaining.unit === 'seconds' ? remaining.remaining : available);
		const selectionContext = { ...context, mediaDuration: undefined, fillerSelection: { fullBudgetSeconds, allowTruncation },
			selectionStart: new Date(stageStartMilliseconds + Math.round(durationSeconds * 1_000)).toISOString() };
		let selected = selectProgram(programId, consumerKey, state, selectionContext, capacity, 'first-fit-arbitrary');
		if (!selected && allowTruncation) {
			selected = selectProgram(programId, consumerKey, state, selectionContext);
		}
		if (!selected) {
			break;
		}
		const naturalDuration = selected.media.durationSeconds!;
		if (naturalDuration > capacity && (remaining.unit === 'count' || policy === 'next-fit-only' || policy === 'best-fit-only')) {
			break;
		}
		if (spans.length >= maxSpans) {
			throw new TimelineMaterializationLimitError(MAX_TIMELINE_SEGMENTS);
		}
		const played = Math.round(Math.min(naturalDuration, capacity) * 1_000) / 1_000;
		if (played <= 0) {
			break;
		}
		spans.push({ media: selected.media, role: 'filler', programId, programAncestry: selected.programAncestry,
			sequenceEntryPath: selected.sequenceEntryPath, sourceStartSeconds: 0, sourceFinishSeconds: played,
			truncated: played < naturalDuration, stateDelta: changedStateRecords(state, selected.state) });
		state = selected.state;
		durationSeconds += played;
		remaining.remaining = Math.max(0, remaining.unit === 'count' ? remaining.remaining - 1 : Math.round((remaining.remaining - played) * 1_000) / 1_000);
	}
	return { spans, state, durationSeconds, initialProgress, progress: remaining };
}
