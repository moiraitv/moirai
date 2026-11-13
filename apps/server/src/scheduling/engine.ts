import { planFiller } from './filler-plan.js';
import { legacyTailPresetId, type FillerSettings } from '@moirai/shared';
import { TimelineMaterializationLimitError } from './limits.js';
export { TimelineMaterializationLimitError } from './limits.js';
import { proposePrimaryAiring } from './primary-airing.js';
import { commitStandaloneFiller, planSlotRoll, reportSlotRoll, reserveSlotOutro } from './slot-rolls.js';
import { durationBetween, plusSeconds, segment } from './timeline-segment.js';
import { commitAiring } from './airing-commit.js';
import { resolveAiringFiller, resolveTailFiller } from './filler-assignment.js';
import { Temporal } from '@js-temporal/polyfill';
import type {
	ChannelSchedule,
	FillerConfig,
	ScheduleSlot,
	ScheduleTemplate,
	SchedulingCatalog,
	SchedulingProgram,
	SelectionStateRecord,
	TimelinePreview,
	TimelineSegment,
	ViewingPreferenceScores,
} from '@moirai/shared';
import { DEFAULT_FILLER_SHORTFALL_WARNING_THRESHOLD_PERCENT, durationMilliseconds, MAX_TIMELINE_SEGMENTS } from '@moirai/shared';
import { instantFor, resolveScheduleDay, type ResolvedScheduleSlot } from './schedule-day.js';
import { guideOccurrence } from '../guide/occurrences.js';
import type { GuideOccurrence } from '@moirai/shared';
import { publicTimelineIssue, type RecordedTimelineIssue } from './timeline-issues.js';
import type { BoundaryRejection, RetainedSlotPlayback, TimelineContinuation } from './continuation.js';
import {
	addIssue,
	indexOccupiedMedia,
	type SelectionContext,
} from './selection.js';

/** Authored rules, catalog, state, and time window needed to resolve a timeline. */
export interface GenerateTimelineInput {
	/** Roll budget warning tolerance; omitted values use the shared default. */
	fillerShortfallWarningThresholdPercent?: number;
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
	/** Resume a matching interval or use retained playback to replan it after a schedule change. */
	initialContinuation?: TimelineContinuation | RetainedSlotPlayback | null;
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

/** Build the stable key that scopes persistent selection state. */
function consumerKey(
	role: 'primary' | 'filler' | 'mid-roll' | 'pre-roll' | 'post-roll' | 'tail' | 'fallback',
	input: GenerateTimelineInput,
	template: ScheduleTemplate,
	slot: ScheduleSlot,
	programId: string,
	date: Temporal.PlainDate,
): string {
	const base = `${role}:${input.channelId}:${template.id}:${slot.id}:${programId}`;
	return slot.stateScope === 'occurrence' ? `${base}:${date.toString()}` : base;
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
	const state = new Map(input.state.map((record) => [record.consumerKey, structuredClone(record)]));
	const issues: RecordedTimelineIssue[] = [];
	const issueKeys = new Set<string>();
	const issueIndex = new Map<string, RecordedTimelineIssue>();
	const candidateCache: SelectionContext['candidateCache'] = new Map();
	const candidateIndexes: NonNullable<SelectionContext['candidateIndexes']> = new WeakMap();
	const fillerSemanticSources = new Map<string, Set<string>>();
	const stateFingerprints: NonNullable<SelectionContext['stateFingerprints']> = new Map();
	const occupiedMediaIndex = indexOccupiedMedia(input.occupiedMedia ?? []);
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
			? { ...activeContinuation, at: entry.finish, phase: entry.role === 'primary' || entry.airing ? 'primary' : activeContinuation.phase === 'primary' ? 'filler' : activeContinuation.phase }
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
			if (resume && (template.id !== resume.templateId || slot.id !== resume.slotId || layerId !== resume.scheduleLayerId
				|| !nominalStart.equals(resume.intervalStart) || !nominalEnd.equals(resume.intervalEnd))) {
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
				fillerShortfallWarningThresholdPercent: input.fillerShortfallWarningThresholdPercent ?? DEFAULT_FILLER_SHORTFALL_WARNING_THRESHOLD_PERCENT,
				programs,
				stateFingerprints,
				catalog: input.catalog,
				candidateCache,
				candidateIndexes,
				fillerSemanticSources,
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
				occupiedMediaIndex,
				avoidCrossChannelDuplicates: input.schedule.avoidCrossChannelDuplicates ?? true,
			};
			const checkpoint = resume?.phase === undefined ? null : resume;
			const replanning = resume !== null && !checkpoint;
			const retainedPrimary = replanning && resume?.hadPrimary;
			let primaryCount = checkpoint?.hadPrimary ? 1 : 0;
			let boundaryRejection: BoundaryRejection | null = checkpoint?.boundaryRejection ?? null;
			const resumingFiller = Boolean(checkpoint && checkpoint.phase !== 'primary' && checkpoint.phase !== 'intro');
			const resumedStage = checkpoint?.phase;
			const resumedProgress = checkpoint?.fillerProgress;
			activeContinuation = {
				at: cursor.toString(), date: date.toString(), templateId: template.id, slotId: slot.id,
				scheduleLayerId: layerId, intervalStart: nominalStart.toString(), intervalEnd: nominalEnd.toString(),
				boundaryOrigin, phase: resumedStage ?? 'primary', ...(resumedProgress ? { fillerProgress: resumedProgress } : {}),
				...(checkpoint?.slotOutro !== undefined ? { slotOutro: checkpoint.slotOutro } : {}), hadPrimary: resume?.hadPrimary ?? false,
				boundaryRejection,
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

			// Resolve the interval's bookends before selecting primary items. Only emit the intro
			// after finding a primary airing that can start behind it.
			const commitContext = { channelId: input.channelId, state, appendSegment };
			const rolls = slot.programId === null ? null : resolveAiringFiller(
				slot,
				template,
				input.schedule,
				input.catalog,
				(kind, programId) => consumerKey(kind, input, template, slot, programId, date),
			);
			const slotPre = rolls?.pre?.frequency === 'once-per-slot' ? rolls.pre : undefined;
			const slotPost = rolls?.post?.frequency === 'once-per-slot' ? rolls.post : undefined;
			const identity = `${input.schedule.generationSeed ?? ''}:${input.channelId}:${template.id}:${slot.id}:${layerId ?? ''}:${date}:${resolved.startSeconds}:${resolved.endSeconds}`;
			const startInside = replanning
				|| (!resumedStage && initialCursor?.equals(cursor) && Temporal.Instant.compare(cursor, nominalStart) > 0);
			let intro = slotPre && !startInside && (!resumedStage || resumedStage === 'intro')
				? planSlotRoll(
					slotPre,
					slotPre.budget,
					state,
					context,
					cursor,
					durationBetween(cursor, nominalEnd),
					input.timeZone,
					identity,
					resumedStage === 'intro' ? resumedProgress : undefined,
				)
				: undefined;
			const afterIntro = plusSeconds(cursor, intro?.durationSeconds ?? 0);
			let outro = slotPost && activeContinuation.slotOutro !== null && (!resumingFiller || primaryCount > 0)
				? reserveSlotOutro(
					slotPost,
					state,
					context,
					afterIntro,
					nominalEnd,
					input.timeZone,
					identity,
					activeContinuation.slotOutro,
					resumedStage === 'outro' ? resumedProgress : undefined,
				)
				: undefined;
			let reserved = outro?.reservation ? Temporal.Instant.from(outro.reservation.start) : null;
			if (slotPost) {
				activeContinuation.slotOutro = outro?.reservation ?? null;
			}

			// Retry the first primary selection without bookends if they prevent an airing.
			const primaryKey = slot.programId ? consumerKey('primary', input, template, slot, slot.programId, date) : '';
			const itemRolls = rolls && { ...rolls, pre: slotPre ? undefined : rolls.pre, post: slotPost ? undefined : rolls.post };
			const rules = itemRolls && { slot, boundary, boundaryLayerId, primaryConsumerKey: primaryKey,
				rolls: itemRolls, timeZone: input.timeZone, seed: input.schedule.generationSeed };
			let first = true;
			while (!resumingFiller && rules && (first || Temporal.Instant.compare(cursor, reserved ?? nominalEnd) < 0)
				&& Temporal.Instant.compare(cursor, windowEnd) < 0) {
				const withBookends = first && !retainedPrimary && primaryCount === 0 && Boolean(intro?.durationSeconds || reserved);
				const trial = withBookends ? { ...context, blockedPrograms: new Set(context.blockedPrograms),
					issues: [], issueKeys: new Set<string>(), issueIndex: new Map<string, RecordedTimelineIssue>() } : context;
				let airing = proposePrimaryAiring(
					rules,
					intro?.state ?? state,
					trial,
					first ? afterIntro : cursor,
					reserved ?? nominalEnd,
					Boolean(reserved),
				);
				if (airing.selected && withBookends) {
					for (const issue of trial.issues) {
						for (const occurrence of issue.occurrences ?? []) {
							addIssue(context, { ...issue, occurrence });
						}
					}
				}
				if (!airing.selected && withBookends) {
					intro = undefined;
					outro = undefined;
					reserved = null;
					if (slotPost) {
						activeContinuation.slotOutro = null;
					}
					airing = proposePrimaryAiring(rules, state, context, cursor, nominalEnd, false);
					if (airing.selected) {
						addIssue(context, { code: 'slot-roll-skipped', message: 'Once-per-slot filler was skipped to make room for primary content.',
							programId: slot.programId, mediaItemId: null });
					}
				}
				if (!airing.selected) {
					resolvedEnd = airing.handoff;
					boundaryRejection = airing.rejection ?? boundaryRejection;
					break;
				}

				// Publish only the accepted airing and its opener. An early intro can cross midnight
				// before the first primary item starts, so retain its progress at the window edge.
				if (first) {
					if (intro && slotPre) {
						reportSlotRoll(context, intro, slotPre, 'pre-roll', cursor);
						cursor = commitStandaloneFiller(commitContext, activeContinuation, 'intro', slotPre.presetId, intro, cursor, windowEnd);
						intro = undefined;
						if (Temporal.Instant.compare(cursor, windowEnd) >= 0) {
							carriedStart = cursor;
							break generation;
						}
					}
					activeContinuation.phase = 'primary';
					delete activeContinuation.fillerProgress;
					first = false;
				}
				for (const issue of airing.plan?.issues ?? []) {
					for (const occurrence of issue.occurrences ?? []) {
						addIssue(context, { ...issue, occurrence });
					}
				}
				commitAiring(commitContext, airing.selected, airing.plan, cursor, airing.finish, template, slot, layerId);
				cursor = airing.finish;
				primaryCount += 1;
				if (airing.endsPrimary) {
					resolvedEnd = airing.finish;
					break;
				}
			}

			if (outro && slotPost && (primaryCount > 0 || retainedPrimary)) {
				reportSlotRoll(context, outro.plan, slotPost, 'post-roll', reserved ?? cursor);
				if (reserved) {
					resolvedEnd = reserved;
				}
			}
			else {
				outro = undefined;
				reserved = null;
				if (slotPost) {
					activeContinuation.slotOutro = null;
				}
			}

			// Let a favor-right boundary end at the final primary item within its drift allowance.
			if (
				boundary.policy === 'favor-right'
				&& !reserved
				&& !resumingFiller
				&& Temporal.Instant.compare(cursor, windowEnd) < 0
				&& boundary.maxDriftSeconds !== null
				&& primaryCount > 0
				&& Temporal.Instant.compare(cursor, nominalEnd) < 0
				&& durationBetween(cursor, nominalEnd) <= boundary.maxDriftSeconds
			) {
				resolvedEnd = cursor;
			}

			// Run tail once, then independently cover remaining time with channel fallback.
			context.mediaDuration = undefined;
			activeContinuation!.boundaryRejection = boundaryRejection;
			const tail = resolveTailFiller(slot, template, input.schedule);
			const stages: Array<{ phase: 'tail' | 'fallback'; config: FillerConfig; settings: FillerSettings }> = [];
			if (tail && resumedStage !== 'fallback' && resumedStage !== 'outro') {
				const settings = input.catalog.fillerPresets?.[tail.presetId ?? legacyTailPresetId(tail.policy)]
					?? (!tail.presetId ? { budget: { type: 'remaining' as const, policy: tail.policy } } : null);
				if (!settings) {
					throw new Error('Selected tail filler preset is unavailable');
				}
				stages.push({ phase: 'tail', config: tail, settings });
			}
			if (input.schedule.defaultFiller && resumedStage !== 'outro') {
				stages.push({ phase: 'fallback', config: input.schedule.defaultFiller,
					settings: { budget: { type: 'remaining', policy: input.schedule.defaultFiller.policy } } });
			}
			for (const stage of stages) {
				if (Temporal.Instant.compare(cursor, resolvedEnd) >= 0 || Temporal.Instant.compare(cursor, windowEnd) >= 0) {
					break;
				}
				context.selectionStart = cursor.toString();
				const available = durationBetween(cursor, resolvedEnd);
				const result = planFiller(
					stage.config.programId,
					stage.settings.budget,
					state,
					context,
					consumerKey(stage.phase === 'tail' ? 'filler' : 'fallback', input, template, slot, stage.config.programId, date),
					input.timeZone,
					`${input.schedule.generationSeed ?? ''}:${input.channelId}:${slot.id}:${date}:${stage.phase}`,
					available,
					resumedStage === stage.phase ? resumedProgress : undefined,
				);
				cursor = commitStandaloneFiller(
					commitContext,
					activeContinuation,
					stage.phase,
					stage.phase === 'tail' ? stage.config.presetId : undefined,
					result,
					cursor,
					windowEnd,
				);
			}

			// Fill any remaining gap before the closing, then emit it against the fixed handoff.
			const appendGap = (end: Temporal.Instant): void => {
				const finish = Temporal.Instant.compare(end, windowEnd) < 0 ? end : windowEnd;
				if (Temporal.Instant.compare(cursor, finish) >= 0) {
					return;
				}
				if (boundaryRejection) {
					addIssue(context, { ...boundaryRejection, occurrence: { start: cursor.toString(), finish: finish.toString(), boundaryOrigin } });
					boundaryRejection = null;
				}
				appendSegment(segment({
					role: 'dead-air', channelId: input.channelId, scheduleLayerId: layerId, templateId: template.id,
					slotId: slot.id, programId: null, mediaItemId: null, title: 'Dead air', playbackPath: null, playbackParts: [],
					start: cursor, finish, sourceStartSeconds: 0, sourceFinishSeconds: null, truncated: false,
				}));
				cursor = finish;
			};
			appendGap(resolvedEnd);
			if (reserved && outro && slotPost) {
				const start = nominalEnd.subtract({ milliseconds: durationMilliseconds(outro.plan.durationSeconds) });
				appendGap(start);
				cursor = commitStandaloneFiller(commitContext, activeContinuation, 'outro', slotPost.presetId, outro.plan, cursor, windowEnd);
			}
			carriedStart = cursor;
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
