import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type {
	ChannelSchedule,
	ChannelScheduleLayer,
	FillerConfig,
	ScheduleBoundary,
	ScheduleSlot,
	ScheduleTemplate,
	SchedulingCatalog,
	SchedulingProgram,
	SelectionStateRecord,
	TimelineIssue,
	TimelinePreview,
	TimelineSegment,
	ViewingPreferenceScores,
} from '@moirai/shared';
import { countLabel, MAX_TIMELINE_SEGMENTS, SECONDS_PER_SCHEDULING_DAY } from '@moirai/shared';
import { predicateTimeBoundaries, schedulePredicateMatches } from './predicate.js';
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
	/** Immutable decayed preference scores captured for this generation pass. */
	viewingPreferences?: ViewingPreferenceScores;
	/** Exact media intervals already committed or generated on other channels. */
	occupiedMedia?: Array<{ mediaItemId: string; start: string; finish: string }>;
}

/** Selection-state change attributed to one generated segment. */
export interface TimelineStateTransition {
	segmentId: string;
	stateDelta: SelectionStateRecord[];
}

/** Concrete timeline plus issues and proposed state changes from generation. */
export interface TimelineGeneration extends TimelinePreview {
	continuationAt: string;
	stateTransitions: TimelineStateTransition[];
}

/** Convert a local template date and offset into an absolute instant. */
function instantFor(date: Temporal.PlainDate, seconds: number, timeZone: string): Temporal.Instant {
	const targetDate = seconds === SECONDS_PER_SCHEDULING_DAY ? date.add({ days: 1 }) : date;
	const secondsInDate = seconds === SECONDS_PER_SCHEDULING_DAY ? 0 : seconds;
	const dateTime = targetDate.toPlainDateTime('00:00').add({ seconds: secondsInDate });
	return dateTime.toZonedDateTime(timeZone, { disambiguation: 'compatible' }).toInstant();
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

/** Effective slot after calendar predicates and template layering are resolved. */
interface ResolvedScheduleSlot {
	template: ScheduleTemplate;
	layerId: string | null;
	layerIndex: number;
	slot: ScheduleSlot;
	startSeconds: number;
	endSeconds: number;
	boundary: ScheduleBoundary;
	boundaryOrigin: 'template' | 'layer-entry' | 'layer-exit';
}

/** Return the nominal template slot active at a wall-clock offset. */
function slotAt(template: ScheduleTemplate, seconds: number): ScheduleSlot {
	const slots = [...template.slots].sort((left, right) => left.startSeconds - right.startSeconds);
	return [...slots].reverse().find((slot) => slot.startSeconds <= seconds) ?? slots[0]!;
}

/** Resolve the authored boundary after a template slot. */
function templateBoundary(template: ScheduleTemplate, slot: ScheduleSlot): ScheduleBoundary {
	return boundaryFor(template, slot);
}

/** Translate a conditional layer entry or exit rule into a slot boundary. */
function layerBoundary(
	layer: ChannelScheduleLayer,
	side: 'entry' | 'exit',
	leftSlotId: string,
	rightSlotId: string,
	targetSeconds: number,
): ScheduleBoundary {
	const config = side === 'entry' ? layer.entryBoundary : layer.exitBoundary;
	return {
		id: `${layer.id}-${side}-${targetSeconds}`,
		leftSlotId,
		rightSlotId,
		targetSeconds,
		...config,
	};
}

/** Returns whether an overrun satisfies a finite boundary or an explicit unlimited finish. */
function isWithinBoundaryDrift(boundary: ScheduleBoundary, overrunSeconds: number): boolean {
	return boundary.maxDriftSeconds === null || overrunSeconds <= boundary.maxDriftSeconds;
}

/** Resolve the applicable layered slots for one local scheduling day. */
function resolveScheduleDay(
	input: GenerateTimelineInput,
	date: Temporal.PlainDate,
): ResolvedScheduleSlot[] {
	// Collect every template and predicate transition that can divide the local day.
	const templateMap = new Map(
		[input.template, ...(input.templates ?? [])].map((template) => [template.id, template]),
	);
	const boundaries = new Set<number>([0, SECONDS_PER_SCHEDULING_DAY]);
	for (const template of templateMap.values()) {
		for (const slot of template.slots) {
			boundaries.add(slot.startSeconds);
		}
	}
	for (const layer of input.schedule.layers) {
		for (const seconds of predicateTimeBoundaries(layer.predicate)) {
			boundaries.add(seconds);
		}
	}
	const points = [...boundaries].sort((left, right) => left - right);

	// Select the highest matching layer with programming, falling through no-program slots.
	const selectionAt = (
		selectionDate: Temporal.PlainDate,
		startSeconds: number,
	): Omit<ResolvedScheduleSlot, 'startSeconds' | 'endSeconds' | 'boundary' | 'boundaryOrigin'> => {
		const instant = instantFor(selectionDate, startSeconds, input.timeZone);
		for (const [layerIndex, layer] of input.schedule.layers.entries()) {
			const template = templateMap.get(layer.templateId);
			if (!template || !schedulePredicateMatches(layer.predicate, instant, input.timeZone)) {
				continue;
			}

			const slot = slotAt(template, startSeconds);
			if (slot.programId !== null) {
				return { template, layerId: layer.id, layerIndex, slot };
			}
		}
		return {
			template: input.template,
			layerId: null,
			layerIndex: Number.MAX_SAFE_INTEGER,
			slot: slotAt(input.template, startSeconds),
		};
	};

	// Resolve each interval and merge adjacent intervals with the same effective slot.
	const preliminary: Omit<ResolvedScheduleSlot, 'boundary' | 'boundaryOrigin'>[] = [];
	for (let index = 0; index < points.length - 1; index += 1) {
		const startSeconds = points[index]!;
		const endSeconds = points[index + 1]!;
		const selected = selectionAt(date, startSeconds);
		const previous = preliminary.at(-1);
		if (
			previous
			&& previous.template.id === selected.template.id
			&& previous.layerId === selected.layerId
			&& previous.slot.id === selected.slot.id
		) {
			previous.endSeconds = endSeconds;
		}
		else {
			preliminary.push({ ...selected, startSeconds, endSeconds });
		}
	}

	// Replace template boundaries with entry or exit policies at layer transitions.
	return preliminary.map((current, index) => {
		const next = preliminary[index + 1] ?? selectionAt(date.add({ days: 1 }), 0);
		let boundary = templateBoundary(current.template, current.slot);
		let boundaryOrigin: ResolvedScheduleSlot['boundaryOrigin'] = 'template';
		if (current.layerId !== next.layerId) {
			if (next.layerId && next.layerIndex < current.layerIndex) {
				const entering = input.schedule.layers.find((layer) => layer.id === next.layerId)!;
				boundary = layerBoundary(
					entering,
					'entry',
					current.slot.id,
					next.slot.id,
					current.endSeconds,
				);
				boundaryOrigin = 'layer-entry';
			}
			else if (current.layerId) {
				const exiting = input.schedule.layers.find((layer) => layer.id === current.layerId)!;
				boundary = layerBoundary(
					exiting,
					'exit',
					current.slot.id,
					next.slot.id,
					current.endSeconds,
				);
				boundaryOrigin = 'layer-exit';
			}
		}
		return {
			...current,
			boundary: { ...boundary, targetSeconds: current.endSeconds },
			boundaryOrigin,
		};
	});
}

/** Return the explicit outgoing boundary for a resolved slot. */
function boundaryFor(template: ScheduleTemplate, slot: ScheduleSlot): ScheduleBoundary {
	const boundary = template.boundaries.find((candidate) => candidate.leftSlotId === slot.id);
	if (!boundary) {
		throw new Error(`Template ${template.id} has no boundary for slot ${slot.id}`);
	}

	return boundary;
}

/** Materialize a timeline plus the continuation data required for an atomic durable commit. */
export function generateTimelineDetailed(input: GenerateTimelineInput): TimelineGeneration {
	// Initialize reusable indexes, selection state, issue tracking, and output limits.
	const programs = new Map(input.programs.map((program) => [program.id, program]));
	let state = new Map(input.state.map((record) => [record.consumerKey, structuredClone(record)]));
	const issues: TimelineIssue[] = [];
	const issueKeys = new Set<string>();
	const candidateCache: SelectionContext['candidateCache'] = new Map();
	const blockedPrograms = new Set<string>();
	const segments: TimelineSegment[] = [];
	const stateTransitions: TimelineStateTransition[] = [];
	const appendSegment = (entry: TimelineSegment): void => {
		if (segments.length >= MAX_TIMELINE_SEGMENTS) {
			throw new TimelineMaterializationLimitError(MAX_TIMELINE_SEGMENTS);
		}

		segments.push(entry);
	};
	const firstDate = Temporal.PlainDate.from(input.startDate);
	let carriedStart: Temporal.Instant | null = input.initialCursor
		? Temporal.Instant.from(input.initialCursor)
		: null;
	const generatedAt = instantFor(firstDate, 0, input.timeZone).toString();

	const appendSelectedSegment = (entry: TimelineSegment, selected: SelectionResult): void => {
		const stateDelta = changedStateRecords(state, selected.state);
		appendSegment(entry);
		state = selected.state;
		if (stateDelta.length > 0) {
			stateTransitions.push({ segmentId: entry.id, stateDelta });
		}
	};

	// Resolve each nominal day into effective template and conditional-layer intervals.
	for (let day = 0; day < input.days; day += 1) {
		const date = firstDate.add({ days: day });
		for (const resolved of resolveScheduleDay(input, date)) {
			const { slot, template, layerId, boundary, boundaryOrigin } = resolved;
			const nominalStart = instantFor(date, resolved.startSeconds, input.timeZone);
			const nominalEnd = instantFor(date, resolved.endSeconds, input.timeZone);
			let cursor: Temporal.Instant = carriedStart ?? nominalStart;
			carriedStart = null;
			const context: SelectionContext = {
				programs,
				catalog: input.catalog,
				candidateCache,
				blockedPrograms,
				issues,
				issueKeys,
				templateId: template.id,
				scheduleLayerId: layerId,
				slotId: slot.id,
				now: generatedAt,
				viewingPreferences: input.viewingPreferences ?? { itemScores: {}, showScores: {} },
				selectionStart: cursor.toString(),
				occupiedMedia: input.occupiedMedia ?? [],
			};
			let primaryCount = 0;
			let resolvedEnd = nominalEnd;

			// Carry prior boundary drift forward and skip slots it displaces completely.
			if (Temporal.Instant.compare(cursor, nominalEnd) >= 0) {
				addIssue(context, {
					code: 'slot-displaced',
					message: 'The slot has no remaining time because the prior boundary resolved after it.',
					programId: slot.programId,
					mediaItemId: null,
				});
				carriedStart = cursor;
				continue;
			}

			// Select primary media until the slot is full or its boundary rejects another start.
			while (slot.programId !== null && Temporal.Instant.compare(cursor, nominalEnd) < 0) {
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
				const fitSeconds
					= layerFinishesOutgoing && boundary.maxDriftSeconds !== null
						? durationBetween(cursor, nominalEnd) + boundary.maxDriftSeconds
						: null;
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
					if (layerFinishesOutgoing && boundary.maxDriftSeconds !== null) {
						addIssue(context, {
							code: 'boundary-start-rejected',
							message: `No outgoing item can finish within ${countLabel(
								Math.round(boundary.maxDriftSeconds / 60),
								'minute',
							)} of the conditional boundary. Selection state was preserved.`,
							programId: slot.programId,
							mediaItemId: null,
						});
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
					if (layerTransition) {
						addIssue(context, {
							code: 'boundary-start-rejected',
							message: 'The next outgoing item cannot satisfy the conditional boundary and '
								+ 'was left unconsumed.',
							programId: slot.programId,
							mediaItemId: selected.media.id,
						});
					}
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
				&& boundary.maxDriftSeconds !== null
				&& primaryCount > 0
				&& Temporal.Instant.compare(cursor, nominalEnd) < 0
				&& durationBetween(cursor, nominalEnd) <= boundary.maxDriftSeconds
			) {
				resolvedEnd = cursor;
			}

			// Fill unused time with interruptible filler according to the inherited policy.
			if (Temporal.Instant.compare(cursor, resolvedEnd) < 0) {
				const filler = fillerFor(slot, template, input.schedule);
				if (filler) {
					while (Temporal.Instant.compare(cursor, resolvedEnd) < 0) {
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
			if (Temporal.Instant.compare(cursor, resolvedEnd) < 0) {
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
						finish: resolvedEnd,
						sourceStartSeconds: 0,
						sourceFinishSeconds: null,
						truncated: false,
					}),
				);
			}
			carriedStart = resolvedEnd;
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
		issues: generated.issues,
		proposedState: generated.proposedState,
	};
}
