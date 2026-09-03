import type { TimelineIssue, TimelineIssueOccurrence } from '@moirai/shared';

/** A deferred boundary failure, emitted only if filler leaves an actual gap. */
export type BoundaryRejection = Pick<TimelineIssue, 'code' | 'message' | 'programId' | 'mediaItemId' | 'scheduleLayerId'>;

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
	phase: 'primary' | 'filler';
	hadPrimary: boolean;
	boundaryRejection: BoundaryRejection | null;
}
