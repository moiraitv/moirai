import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type {
	ChannelSchedule,
	FillerConfig,
	ScheduleBoundary,
	ScheduleSlot,
	ScheduleTemplate,
	SchedulingCatalog,
	SchedulingProgram,
	SelectionStateRecord,
	TimelinePreview,
	TimelineSegment,
	ViewingPreferenceScores,
} from '@moirai/shared';
import { countLabel, MAX_TIMELINE_SEGMENTS } from '@moirai/shared';
import { instantFor, resolveScheduleDay, type ResolvedScheduleSlot } from './schedule-day.js';
import { guideOccurrence } from '../guide/occurrences.js';
import type { GuideOccurrence } from '@moirai/shared';
import { publicTimelineIssue, type RecordedTimelineIssue } from './timeline-issues.js';
import type { BoundaryRejection, TimelineContinuation } from './continuation.js';
import {
	addIssue,
	changedStateRecords,
	selectProgram,
	type SelectionResult,
	type SelectionContext,
} from './selection.js';

/** Report a preview whose media granularity exceeds the segment resource limit. */
export class TimelineMaterializationLimitError extends Error {
	readonly statusCode = 422;

	constructor(readonly limit: number) {
		super(`Timeline preview exceeds the ${limit.toLocaleString('en-US')} segment limit`);
		this.name = 'TimelineMaterializationLimitError';
	}
}

/** Authored rules, catalog, state, and time window needed to resolve a timeline. */
export interface GenerateTimelineInput {
	channelId: string;
	timeZone: string;
	startDate: string;
	days: number;
	schedule: ChannelSchedule;
	template: ScheduleTemplate;
	templates?: ScheduleTemplate[];
	programs: SchedulingProgram[];
	catalog: SchedulingCatalog;
	state: SelectionStateRecord[];
	/** Continue a committed range at this instant instead of the first local midnight. */
	initialCursor?: string;
	/** Resume the unfinished slot recorded at initialCursor, when the schedule is unchanged. */
	initialContinuation?: TimelineContinuation | null;
	/** Immutable decayed preference scores captured for this generation pass. */
	viewingPreferences?: ViewingPreferenceScores;
	/** Exact media intervals already committed or generated on other channels. */
	occupiedMedia?: Array<{ mediaItemId: string; start: string; finish: string }>;
}

/** Selection-state change attributed to one generated segment. */
export interface TimelineStateTransition {
	segmentId: string;
	stateDelta: SelectionStateRecord[];
	continuation?: TimelineContinuation | null;
}

/** Concrete timeline plus issues and proposed state changes from generation. */
export interface TimelineGeneration extends TimelinePreview {
	guideOccurrences: GuideOccurrence[];
	issues: RecordedTimelineIssue[];
	continuationAt: string;
	continuation: TimelineContinuation | null;
	stateTransitions: TimelineStateTransition[];
}

/** Return exact millisecond-backed elapsed seconds between two absolute instants. */
function durationBetween(start: Temporal.Instant, finish: Temporal.Instant): number {
	return Math.max(0, (finish.epochMilliseconds - start.epochMilliseconds) / 1_000);
}

/** Advance an instant by an elapsed duration while preserving millisecond precision. */
function plusSeconds(start: Temporal.Instant, seconds: number): Temporal.Instant {
	return start.add({ milliseconds: Math.round(seconds * 1_000) });
}

/** Create a repeatable identifier for one materialized timeline segment. */
function stableSegmentId(parts: string[]): string {
	const hex = createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** Build one concrete timeline segment from selected media. */
function segment(
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

/** Build the stable key that scopes persistent selection state. */
function consumerKey(
	role: 'primary' | 'filler',
	input: GenerateTimelineInput,
	template: ScheduleTemplate,
	slot: ScheduleSlot,
	programId: string,
	date: Temporal.PlainDate,
): string {
	const base = `${role}:${input.channelId}:${template.id}:${slot.id}:${programId}`;
	return slot.stateScope === 'occurrence' ? `${base}:${date.toString()}` : base;
}

/** Resolve filler using slot, template, then channel inheritance. */
function fillerFor(
	slot: ScheduleSlot,
	template: ScheduleTemplate,
	schedule: ChannelSchedule,
): FillerConfig | null {
	if (slot.programId === null) {
		return schedule.defaultFiller;
	}

	if (slot.filler.mode === 'disabled') {
		return null;
	}

	if (slot.filler.mode === 'configured') {
		return slot.filler.config;
	}

	return template.defaultFiller ?? schedule.defaultFiller;
}

/** Returns whether an overrun satisfies a finite boundary or an explicit unlimited finish. */
function isWithinBoundaryDrift(boundary: ScheduleBoundary, overrunSeconds: number): boolean {
	return boundary.maxDriftSeconds === null || overrunSeconds <= boundary.maxDriftSeconds;
}

/** Return whether a finite finish-left boundary may hand off before its nominal time. */
function canStartIncomingEarly(
	boundary: ScheduleBoundary,
	cursor: Temporal.Instant,
	nominalEnd: Temporal.Instant,
): boolean {
	return boundary.policy === 'finish-left'
		&& boundary.maxDriftSeconds !== null
		&& boundary.fallback === 'favor-right'
		&& Temporal.Instant.compare(cursor, nominalEnd) <= 0
		&& durationBetween(cursor, nominalEnd) <= (boundary.earlyStartMaxDriftSeconds ?? 0);
}

/** Bound late-first selection without changing legacy template or explicit truncation behavior. */
function primaryFitSeconds(
	slot: ScheduleSlot,
	boundary: ScheduleBoundary,
	layerTransition: boolean,
	availableSeconds: number,
): number | null {
	if (boundary.policy !== 'finish-left' || boundary.maxDriftSeconds === null) {
		return null;
	}
	if (layerTransition) {
		return availableSeconds + boundary.maxDriftSeconds;
	}
	if (boundary.fallback !== 'favor-right' || slot.startEligibility.type === 'allow-truncate') {
		return null;
	}

	const slotDrift = slot.startEligibility.type === 'allow-overrun'
		? boundary.maxDriftSeconds
		: slot.startEligibility.type === 'within-drift' ? slot.startEligibility.maxDriftSeconds : 0;
	return availableSeconds + Math.min(slotDrift, boundary.maxDriftSeconds);
}

/** Apply the channel regeneration seed only to programs without an explicit authored seed. */
function generationProgram(program: SchedulingProgram, seed?: string): SchedulingProgram {
	const config = program.config;
	if (seed && config.type === 'sequence' && config.ordering && 'seed' in config.ordering && !config.ordering.seed) {
		return { ...program, config: { ...config, ordering: { ...config.ordering, seed } } };
	}
	if (!seed || config.type !== 'content' || !('seed' in config.strategy) || config.strategy.seed) {
		return program;
	}

	return { ...program, config: { ...config, strategy: { ...config.strategy, seed } } };
}

/** Materialize a timeline plus the continuation data required for an atomic durable commit. */
export function generateTimelineDetailed(input: GenerateTimelineInput): TimelineGeneration {
	// Initialize reusable indexes, selection state, issue tracking, and output limits.
	const programs = new Map(input.programs.map((program) => [program.id, generationProgram(program, input.schedule.generationSeed)]));
	let state = new Map(input.state.map((record) => [record.consumerKey, structuredClone(record)]));
	const issues: RecordedTimelineIssue[] = [];
	const issueKeys = new Set<string>();
	const issueIndex = new Map<string, RecordedTimelineIssue>();
	const candidateCache: SelectionContext['candidateCache'] = new Map();
	const blockedPrograms = new Set<string>();
	const segments: TimelineSegment[] = [];
	const guideOccurrences: GuideOccurrence[] = [];
	let activeOccurrence: GuideOccurrence | null = null;
	const stateTransitions: TimelineStateTransition[] = [];
	let activeContinuation: TimelineContinuation | null = null;
	let continuation: TimelineContinuation | null = null;
	const appendSegment = (entry: TimelineSegment, stateDelta: SelectionStateRecord[] = []): void => {
		if (segments.length >= MAX_TIMELINE_SEGMENTS) {
			throw new TimelineMaterializationLimitError(MAX_TIMELINE_SEGMENTS);
		}

		segments.push(entry);
		if (activeOccurrence) {
			activeOccurrence.actualStart ??= entry.start;
			activeOccurrence.actualFinish = entry.finish;
		}
		if (activeContinuation && entry.role === 'primary') {
			activeContinuation.hadPrimary = true;
		}
		continuation = activeContinuation && Temporal.Instant.compare(entry.finish, activeContinuation.intervalEnd) < 0
			? { ...activeContinuation, at: entry.finish, phase: entry.role === 'primary' ? 'primary' : 'filler' }
			: null;
		stateTransitions.push({ segmentId: entry.id, stateDelta, continuation });
	};
	const firstDate = Temporal.PlainDate.from(input.startDate);
	const windowEnd = instantFor(firstDate.add({ days: input.days }), 0, input.timeZone);
	const initialCursor = input.initialCursor ? Temporal.Instant.from(input.initialCursor) : null;
	let carriedStart: Temporal.Instant | null = input.initialCursor
		? initialCursor
		: null;
	let carriedBoundary: Pick<ResolvedScheduleSlot, 'boundaryOrigin' | 'boundaryLayerId'> | null = null;
	const generatedAt = instantFor(firstDate, 0, input.timeZone).toString();
	const saved = input.initialContinuation;
	// Ignore checkpoints for a different cursor or resolved interval.
	let resume = saved && initialCursor && Temporal.Instant.compare(saved.at, initialCursor) === 0
		&& Temporal.Instant.compare(initialCursor, saved.intervalEnd) < 0
		&& resolveScheduleDay(input, Temporal.PlainDate.from(saved.date)).some((resolved) =>
			resolved.template.id === saved.templateId && resolved.slot.id === saved.slotId
			&& resolved.layerId === saved.scheduleLayerId
			&& instantFor(Temporal.PlainDate.from(saved.date), resolved.startSeconds, input.timeZone).toString() === saved.intervalStart
			&& instantFor(Temporal.PlainDate.from(saved.date), resolved.endSeconds, input.timeZone).toString() === saved.intervalEnd)
		? saved : null;

	const appendSelectedSegment = (entry: TimelineSegment, selected: SelectionResult): void => {
		const stateDelta = changedStateRecords(state, selected.state);
		appendSegment({ ...entry, programAncestry: selected.programAncestry ?? [],
			...(selected.sequenceEntryPath ? { sequenceEntryPath: selected.sequenceEntryPath } : {}) }, stateDelta);
		state = selected.state;
	};

	// Follow actual handoffs until covered, then record slots consumed by the final committed item.
	// Early drift and media-duration limits bound lookahead even when several handoffs share a cursor.
	generation: for (let day = 0; ; day += 1) {
		if (day >= input.days && (!carriedStart
			|| (Temporal.Instant.compare(carriedStart, windowEnd) >= 0 && !carriedBoundary))) {
			break;
		}
		const date = firstDate.add({ days: day });
		for (const resolved of resolveScheduleDay(input, date)) {
			const { slot, template, layerId, boundary, boundaryOrigin, boundaryLayerId } = resolved;
			const nominalStart = instantFor(date, resolved.startSeconds, input.timeZone);
			const nominalEnd = instantFor(date, resolved.endSeconds, input.timeZone);
			activeOccurrence = Temporal.Instant.compare(nominalStart, windowEnd) < 0
				|| (carriedStart !== null && Temporal.Instant.compare(carriedStart, windowEnd) < 0)
				? guideOccurrence(input.channelId, resolved, date, input.timeZone) : null;
			if (activeOccurrence) {
				guideOccurrences.push(activeOccurrence);
			}
			if (resume && Temporal.Instant.compare(nominalStart, resume.intervalStart) < 0) {
				continue;
			}
			let cursor: Temporal.Instant = carriedStart ?? nominalStart;
			carriedStart = null;
			if (Temporal.Instant.compare(cursor, windowEnd) >= 0
				&& (!carriedBoundary || Temporal.Instant.compare(cursor, nominalEnd) < 0)) {
				carriedStart = cursor;
				break generation;
			}
			const context: SelectionContext = {
				programs,
				catalog: input.catalog,
				candidateCache,
				blockedPrograms,
				fitRejectionCount: 0,
				issues,
				issueKeys,
				issueIndex,
				boundaryOrigin,
				templateId: template.id,
				scheduleLayerId: layerId,
				slotId: slot.id,
				now: generatedAt,
				viewingPreferences: input.viewingPreferences ?? { itemScores: {}, showScores: {} },
				selectionStart: cursor.toString(),
				occupiedMedia: input.occupiedMedia ?? [],
			};
			let primaryCount = resume?.hadPrimary ? 1 : 0;
			let boundaryRejection: BoundaryRejection | null = resume?.boundaryRejection ?? null;
			const resumingFiller = resume?.phase === 'filler';
			activeContinuation = {
				at: cursor.toString(), date: date.toString(), templateId: template.id, slotId: slot.id,
				scheduleLayerId: layerId, intervalStart: nominalStart.toString(), intervalEnd: nominalEnd.toString(),
				boundaryOrigin, phase: resumingFiller ? 'filler' : 'primary', hadPrimary: primaryCount > 0, boundaryRejection,
			};
			resume = null;
			let resolvedEnd = nominalEnd;

			// Carry prior boundary drift forward and skip slots it displaces completely.
			if (Temporal.Instant.compare(cursor, nominalEnd) >= 0) {
				const skippedBeforeInitialCursor
					= initialCursor !== null && Temporal.Instant.compare(nominalEnd, initialCursor) <= 0;
				if (!skippedBeforeInitialCursor) {
					addIssue(context, {
						code: 'slot-displaced',
						message: 'An earlier item displaced this entire slot. Reduce its boundary drift or '
							+ 'choose a boundary behavior that hands off sooner.',
						programId: slot.programId,
						mediaItemId: null,
						scheduleLayerId: carriedBoundary ? carriedBoundary.boundaryLayerId : layerId,
						occurrence: {
							start: nominalStart.toString(),
							finish: nominalEnd.toString(),
							boundaryOrigin: carriedBoundary?.boundaryOrigin ?? null,
						},
					});
				}
				carriedStart = cursor;
				continue;
			}

			// Select primary media until the slot is full or its boundary rejects another start.
			while (!resumingFiller && slot.programId !== null && Temporal.Instant.compare(cursor, nominalEnd) < 0
				&& Temporal.Instant.compare(cursor, windowEnd) < 0) {
				context.selectionStart = cursor.toString();
				const primaryConsumerKey = consumerKey(
					'primary',
					input,
					template,
					slot,
					slot.programId,
					date,
				);
				const layerTransition = boundaryOrigin !== 'template';
				const layerFinishesOutgoing = layerTransition && boundary.policy === 'finish-left';
				const fitSeconds = primaryFitSeconds(slot, boundary, layerTransition, durationBetween(cursor, nominalEnd));
				const previousFitRejections = context.fitRejectionCount;
				let selected = selectProgram(
					slot.programId,
					primaryConsumerKey,
					state,
					context,
					fitSeconds,
					'first-fit-arbitrary',
				);
				if (
					!selected
					&& layerFinishesOutgoing
					&& boundary.maxDriftSeconds !== null
					&& boundary.fallback === 'truncate-left'
				) {
					selected = selectProgram(slot.programId, primaryConsumerKey, state, context);
				}
				if (!selected) {
					if (canStartIncomingEarly(boundary, cursor, nominalEnd)) {
						resolvedEnd = cursor;
						break;
					}

					if (fitSeconds !== null && context.fitRejectionCount > previousFitRejections) {
						boundaryRejection = {
							code: 'boundary-start-rejected',
							message: layerTransition ? `No outgoing item can finish within ${countLabel(
								Math.round(boundary.maxDriftSeconds! / 60),
								'minute',
							)} of the conditional boundary. Selection state was preserved.`
								: 'No outgoing item satisfies this template boundary. Review start eligibility, '
									+ 'drift, or fallback behavior. Selection state was preserved.',
							programId: slot.programId,
							mediaItemId: null,
							scheduleLayerId: boundaryLayerId,
						};
					}
					break;
				}

				const naturalFinish = plusSeconds(cursor, selected.media.durationSeconds!);
				const crossesBoundary = Temporal.Instant.compare(naturalFinish, nominalEnd) > 0;
				if (!crossesBoundary) {
					appendSelectedSegment(
						segment({
							role: 'primary',
							channelId: input.channelId,
							scheduleLayerId: layerId,
							templateId: template.id,
							slotId: slot.id,
							programId: slot.programId,
							mediaItemId: selected.media.id,
							title: selected.media.title,
							playbackPath: selected.media.playbackPath,
							playbackParts: selected.media.playbackParts ?? [{
								playbackPath: selected.media.playbackPath,
								durationSeconds: selected.media.durationSeconds!,
							}],
							start: cursor,
							finish: naturalFinish,
							sourceStartSeconds: 0,
							sourceFinishSeconds: selected.media.durationSeconds,
							truncated: false,
						}),
						selected,
					);
					cursor = naturalFinish;
					primaryCount += 1;
					continue;
				}

				const overrunSeconds = durationBetween(nominalEnd, naturalFinish);
				const eligibleForOverrun
					= slot.startEligibility.type === 'allow-overrun'
						|| (slot.startEligibility.type === 'within-drift'
							&& overrunSeconds <= slot.startEligibility.maxDriftSeconds);
				const finishLeft
					= boundary.policy === 'finish-left'
						&& (layerTransition || eligibleForOverrun)
						&& isWithinBoundaryDrift(boundary, overrunSeconds);
				const truncate = layerTransition
					? boundary.fallback === 'truncate-left'
					: slot.startEligibility.type === 'allow-truncate'
						|| (eligibleForOverrun && boundary.fallback === 'truncate-left');
				if (!finishLeft && !truncate) {
					if (canStartIncomingEarly(boundary, cursor, nominalEnd)) {
						resolvedEnd = cursor;
						break;
					}

					const boundaryLabel = layerTransition ? 'conditional boundary' : 'template boundary';
					boundaryRejection = {
						code: 'boundary-start-rejected',
						message: `The next outgoing item cannot satisfy the ${boundaryLabel} and was `
							+ 'left unconsumed. Review start eligibility, drift, or fallback behavior.',
						programId: slot.programId,
						mediaItemId: selected.media.id,
						scheduleLayerId: boundaryLayerId,
					};
					break;
				}

				const finish = finishLeft ? naturalFinish : nominalEnd;
				const playedSeconds = durationBetween(cursor, finish);
				appendSelectedSegment(
					segment({
						role: 'primary',
						channelId: input.channelId,
						scheduleLayerId: layerId,
						templateId: template.id,
						slotId: slot.id,
						programId: slot.programId,
						mediaItemId: selected.media.id,
						title: selected.media.title,
						playbackPath: selected.media.playbackPath,
						playbackParts: selected.media.playbackParts ?? [{
							playbackPath: selected.media.playbackPath,
							durationSeconds: selected.media.durationSeconds!,
						}],
						start: cursor,
						finish,
						sourceStartSeconds: 0,
						sourceFinishSeconds: playedSeconds,
						truncated: !finishLeft,
					}),
					selected,
				);
				cursor = finish;
				primaryCount += 1;
				resolvedEnd = finish;
				break;
			}

			// Let a favor-right boundary end at the final primary item within its drift allowance.
			if (
				boundary.policy === 'favor-right'
				&& !resumingFiller
				&& Temporal.Instant.compare(cursor, windowEnd) < 0
				&& boundary.maxDriftSeconds !== null
				&& primaryCount > 0
				&& Temporal.Instant.compare(cursor, nominalEnd) < 0
				&& durationBetween(cursor, nominalEnd) <= boundary.maxDriftSeconds
			) {
				resolvedEnd = cursor;
			}

			// Fill unused time with interruptible filler according to the inherited policy.
			activeContinuation.boundaryRejection = boundaryRejection;
			if (Temporal.Instant.compare(cursor, resolvedEnd) < 0) {
				const filler = fillerFor(slot, template, input.schedule);
				if (filler) {
					while (Temporal.Instant.compare(cursor, resolvedEnd) < 0 && Temporal.Instant.compare(cursor, windowEnd) < 0) {
						context.selectionStart = cursor.toString();
						const available = durationBetween(cursor, resolvedEnd);
						const bestFit
							= filler.policy === 'best-fit-only' || filler.policy === 'best-fit-or-truncate';
						let selected = selectProgram(
							filler.programId,
							consumerKey('filler', input, template, slot, filler.programId, date),
							state,
							context,
							bestFit ? available : null,
						);
						if (!selected && filler.policy === 'best-fit-or-truncate') {
							selected = selectProgram(
								filler.programId,
								consumerKey('filler', input, template, slot, filler.programId, date),
								state,
								context,
							);
						}
						if (!selected) {
							break;
						}

						const naturalFinish = plusSeconds(cursor, selected.media.durationSeconds!);
						const fits = Temporal.Instant.compare(naturalFinish, resolvedEnd) <= 0;
						if (!fits && (filler.policy === 'next-fit-only' || filler.policy === 'best-fit-only')) {
							break;
						}

						const finish = fits ? naturalFinish : resolvedEnd;
						appendSelectedSegment(
							segment({
								role: 'filler',
								channelId: input.channelId,
								scheduleLayerId: layerId,
								templateId: template.id,
								slotId: slot.id,
								programId: filler.programId,
								mediaItemId: selected.media.id,
								title: selected.media.title,
								playbackPath: selected.media.playbackPath,
								playbackParts: selected.media.playbackParts ?? [{
									playbackPath: selected.media.playbackPath,
									durationSeconds: selected.media.durationSeconds!,
								}],
								start: cursor,
								finish,
								sourceStartSeconds: 0,
								sourceFinishSeconds: durationBetween(cursor, finish),
								truncated: !fits,
							}),
							selected,
						);
						cursor = finish;
					}
				}
			}

			// Materialize any remaining gap explicitly so downstream output stays continuous.
			const gapEnd = Temporal.Instant.compare(resolvedEnd, windowEnd) < 0 ? resolvedEnd : windowEnd;
			if (Temporal.Instant.compare(cursor, gapEnd) < 0) {
				if (boundaryRejection) {
					addIssue(context, {
						...boundaryRejection,
						occurrence: { start: cursor.toString(), finish: gapEnd.toString(), boundaryOrigin },
					});
				}
				appendSegment(
					segment({
						role: 'dead-air',
						channelId: input.channelId,
						scheduleLayerId: layerId,
						templateId: template.id,
						slotId: slot.id,
						programId: null,
						mediaItemId: null,
						title: 'Dead air',
						playbackPath: null,
						playbackParts: [],
						start: cursor,
						finish: gapEnd,
						sourceStartSeconds: 0,
						sourceFinishSeconds: null,
						truncated: false,
					}),
				);
			}
			carriedStart = Temporal.Instant.compare(cursor, gapEnd) > 0 ? cursor : gapEnd;
			carriedBoundary = Temporal.Instant.compare(resolvedEnd, nominalEnd) > 0
				? { boundaryOrigin, boundaryLayerId }
				: null;
		}
	}

	// Return concrete output together with state transitions needed for a durable commit.
	return {
		channelId: input.channelId,
		timeZone: input.timeZone,
		startDate: firstDate.toString(),
		days: input.days,
		segments,
		issues,
		proposedState: [...state.values()].sort((a, b) => a.consumerKey.localeCompare(b.consumerKey)),
		continuationAt: (
			carriedStart ?? instantFor(firstDate.add({ days: input.days }), 0, input.timeZone)
		).toString(),
		stateTransitions,
		guideOccurrences,
		continuation,
	};
}

/** Materialize a read-only timeline preview without exposing commit-only continuation details. */
export function generateTimeline(input: GenerateTimelineInput): TimelinePreview {
	const generated = generateTimelineDetailed(input);
	return {
		channelId: generated.channelId,
		timeZone: generated.timeZone,
		startDate: generated.startDate,
		days: generated.days,
		segments: generated.segments,
		issues: generated.issues.map(publicTimelineIssue),
		proposedState: generated.proposedState,
	};
}
