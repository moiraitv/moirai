import { countLabel, spanDurationMilliseconds, type ScheduleBoundary, type ScheduleSlot, type SelectionStateRecord } from '@moirai/shared';
import { Temporal } from '@js-temporal/polyfill';
import type { BoundaryRejection } from './continuation.js';
import type { ResolvedAiringFiller } from './filler-assignment.js';
import { planAiring, type AiringPlan } from './mid-roll.js';
import { selectProgram, type SelectionContext, type SelectionResult } from './selection.js';
import { durationBetween, plusSeconds } from './timeline-segment.js';

/** An accepted airing or a handoff that leaves the next item unconsumed. */
export type PrimaryAiring = { selected: SelectionResult; plan: AiringPlan | null; finish: Temporal.Instant; endsPrimary: boolean }
	| { selected: null; rejection: BoundaryRejection | null; handoff: Temporal.Instant };

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

/** Return whether a finite finish-left boundary may hand off before its nominal time. */
function canStartIncomingEarly(boundary: ScheduleBoundary, cursor: Temporal.Instant, end: Temporal.Instant): boolean {
	return boundary.policy === 'finish-left'
		&& boundary.maxDriftSeconds !== null
		&& boundary.fallback === 'favor-right'
		&& Temporal.Instant.compare(cursor, end) <= 0
		&& durationBetween(cursor, end) <= (boundary.earlyStartMaxDriftSeconds ?? 0);
}

/** Fixed rules and cursor identity shared by the primary airings of one interval. */
export interface PrimaryAiringRules {
	slot: ScheduleSlot;
	boundary: ScheduleBoundary;
	boundaryLayerId: string | null;
	primaryConsumerKey: string;
	rolls: ResolvedAiringFiller;
	timeZone: string;
	seed: string | undefined;
}

/** Select an airing, charging all item rolls to its fit and protecting any reserved closing. */
export function proposePrimaryAiring(
	rules: PrimaryAiringRules,
	state: Map<string, SelectionStateRecord>,
	context: SelectionContext,
	cursor: Temporal.Instant,
	end: Temporal.Instant,
	reserved: boolean,
): PrimaryAiring {
	const { slot, boundary, boundaryLayerId, primaryConsumerKey, rolls, timeZone, seed } = rules;
	context.selectionStart = cursor.toString();
	const layerTransition = context.boundaryOrigin !== 'template';
	const layerFinishesOutgoing = layerTransition && boundary.policy === 'finish-left';
	const available = durationBetween(cursor, end);
	if (available === 0) {
		return { selected: null, rejection: null, handoff: end };
	}

	const fitSeconds = reserved ? available : primaryFitSeconds(slot, boundary, layerTransition, available);
	const { midRoll, pre, post, midRollConsumerKey } = rolls;
	const plans = midRoll || pre || post ? new Map<string, AiringPlan>() : null;
	const planned = (media: SelectionResult['media']): AiringPlan | null => {
		if (!plans) {
			return null;
		}
		let plan = plans.get(media.id);
		if (!plan) {
			plan = planAiring(
				media,
				slot.programId!,
				midRoll,
				state,
				context,
				midRollConsumerKey,
				timeZone,
				{ ...(pre ? { pre } : {}), ...(post ? { post } : {}), ...(seed ? { seed } : {}) },
			);
			plans.set(media.id, plan);
		}
		return plan;
	};
	const rejection = (message: string, mediaItemId: string | null = null): PrimaryAiring => ({
		selected: null, handoff: end,
		rejection: { code: 'boundary-start-rejected', message, programId: slot.programId, mediaItemId, scheduleLayerId: boundaryLayerId },
	});

	// Look for a complete fit before considering permitted truncation.
	const previousFitRejections = context.fitRejectionCount;
	context.mediaDuration = plans ? media => planned(media)!.durationSeconds : undefined;
	let selected = selectProgram(slot.programId!, primaryConsumerKey, state, context, fitSeconds, 'first-fit-arbitrary');
	const mayTruncate = layerTransition ? boundary.fallback === 'truncate-left'
		: slot.startEligibility.type === 'allow-truncate'
			|| (boundary.fallback === 'truncate-left' && (slot.startEligibility.type === 'allow-overrun'
				|| slot.startEligibility.type === 'within-drift'));
	if (!selected && (reserved ? mayTruncate
		: layerFinishesOutgoing && boundary.maxDriftSeconds !== null && boundary.fallback === 'truncate-left')) {
		selected = selectProgram(slot.programId!, primaryConsumerKey, state, context);
	}
	if (!selected) {
		context.mediaDuration = undefined;
		if (!reserved && canStartIncomingEarly(boundary, cursor, end)) {
			return { selected: null, rejection: null, handoff: cursor };
		}
		if (fitSeconds !== null && context.fitRejectionCount > previousFitRejections) {
			return rejection(reserved ? 'No primary item fits before the reserved post-roll.'
				: layerTransition ? `No outgoing item can finish within ${countLabel(
					Math.round(boundary.maxDriftSeconds! / 60),
					'minute',
				)} of the conditional boundary. Selection state was preserved.`
					: 'No outgoing item satisfies this template boundary. Review start eligibility, '
						+ 'drift, or fallback behavior. Selection state was preserved.');
		}
		return { selected: null, rejection: null, handoff: end };
	}

	// Accept the full airing, or check the authored rules before cutting at the available boundary.
	const plan = planned(selected.media);
	context.mediaDuration = undefined;
	const naturalFinish = plusSeconds(cursor, plan?.durationSeconds ?? selected.media.durationSeconds!);
	if (Temporal.Instant.compare(naturalFinish, end) <= 0) {
		return { selected, plan, finish: naturalFinish, endsPrimary: false };
	}

	const overrunSeconds = durationBetween(end, naturalFinish);
	const eligibleForOverrun = slot.startEligibility.type === 'allow-overrun'
		|| (slot.startEligibility.type === 'within-drift' && overrunSeconds <= slot.startEligibility.maxDriftSeconds);
	const finishLeft = !reserved && boundary.policy === 'finish-left' && (layerTransition || eligibleForOverrun)
		&& (boundary.maxDriftSeconds === null || overrunSeconds <= boundary.maxDriftSeconds);
	const truncate = layerTransition ? boundary.fallback === 'truncate-left'
		: slot.startEligibility.type === 'allow-truncate' || (eligibleForOverrun && boundary.fallback === 'truncate-left');
	const firstPrimaryIndex = plan?.spans.findIndex(span => span.role === 'primary') ?? 0;
	const preMilliseconds = plan?.spans.slice(0, firstPrimaryIndex).reduce((total, span) => total + spanDurationMilliseconds(span.sourceStartSeconds, span.sourceFinishSeconds), 0) ?? 0;
	if (!finishLeft && truncate && preMilliseconds >= end.epochMilliseconds - cursor.epochMilliseconds) {
		return rejection('Pre-roll would consume the entire remaining slot without primary content.', selected.media.id);
	}
	if (!finishLeft && !truncate) {
		if (!reserved && canStartIncomingEarly(boundary, cursor, end)) {
			return { selected: null, rejection: null, handoff: cursor };
		}
		const label = layerTransition ? 'conditional boundary' : 'template boundary';
		return rejection(
			reserved ? 'The next primary item cannot finish before the reserved post-roll.'
				: `The next outgoing item cannot satisfy the ${label} and was left unconsumed. Review start eligibility, drift, or fallback behavior.`,
			selected.media.id,
		);
	}

	return { selected, plan, finish: finishLeft ? naturalFinish : end, endsPrimary: true };
}
