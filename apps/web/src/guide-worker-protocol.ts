import type { ApiErrorBody, GuideEntry, ScheduleGuide, TimelineSegment } from '@moirai/shared';
import type { ScheduleDaySummary, ScheduleSummaryWindow } from './channel-schedule-preview';

/** Viewport queries use elapsed milliseconds and retain existing tiny-listing hit geometry. */
export interface GuideWorkerRange {
	channelIds: string[];
	start: number;
	finish: number;
	minimumDuration: number;
	segmentsOnly?: boolean;
}

/** Browser worker owns one active guide for fetching, viewport queries, and rolling summaries. */
export type GuideWorkerRequest
	= | { id: number; kind: 'load'; url: string }
		| { id: number; kind: 'query'; snapshot: number; range: GuideWorkerRange }
		| { id: number; kind: 'summaries'; snapshot: number; window: ScheduleSummaryWindow }
		| { id: number; kind: 'clear' };

/** Compact replies exclude the full retained guide and carry safe HTTP failures unchanged. */
export interface GuideWorkerReply {
	id: number;
	snapshot?: number;
	guide?: ScheduleGuide;
	listings?: Array<[string, Array<GuideEntry | TimelineSegment>]>;
	summaries?: Array<[string, ScheduleDaySummary]>;
	error?: { message: string; name: string; status?: number; body?: ApiErrorBody };
}
