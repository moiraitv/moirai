import type { FillerProgress } from './filler-plan.js';
import type { TimelineIssue, TimelineIssueOccurrence } from '@moirai/shared';

/** A deferred boundary failure, emitted only if filler leaves an actual gap. */
export type BoundaryRejection = Pick<TimelineIssue, 'code' | 'message' | 'programId' | 'mediaItemId' | 'scheduleLayerId'>;

/** Reserved closing window and the inputs needed to resume its speculative filler selection. */
export interface SlotOutroReservation {
	start: string;
	/** Selection clock for the reserved clips, including earlier checkpoints. */
	selectionStart: string;
	progress: FillerProgress;
	/** Keep the original plan when collision avoidance could not supply the reserved duration. */
	ignoreCollisions?: true;
}

/**
 * Internal checkpoint after a committed segment in an unfinished nominal slot. It preserves the
 * primary/filler phase and early-started occurrence without mixing them into program selection state.
 */
export interface TimelineContinuation {
	at: string;
	date: string;
	templateId: string;
	slotId: string;
	scheduleLayerId: string | null;
	intervalStart: string;
	intervalEnd: string;
	boundaryOrigin: TimelineIssueOccurrence['boundaryOrigin'];
	phase: 'intro' | 'primary' | 'filler' | 'tail' | 'fallback' | 'outro';
	fillerProgress?: FillerProgress;
	/** Null records a closing already evaluated for this interval without reserving airtime. */
	slotOutro?: SlotOutroReservation | null;
	hadPrimary: boolean;
	boundaryRejection: BoundaryRejection | null;
}

/** Committed playback evidence usable when new scheduling inputs require replanning an interval. */
export type RetainedSlotPlayback = Pick<TimelineContinuation,
	'at' | 'date' | 'templateId' | 'slotId' | 'scheduleLayerId' | 'intervalStart' | 'intervalEnd' | 'hadPrimary'>
	& { phase?: never };
