import { Temporal } from '@js-temporal/polyfill';
import type { TimelinePreview, TimelineSegment } from '@moirai/shared';
import { guideWindowMilliseconds } from './guide-geometry';

/** Filler stages represented by the compact preview tick legend. */
export const PREVIEW_FILLER_STAGES = [
	{ kind: 'pre-roll', label: 'Pre', name: 'Pre-roll' },
	{ kind: 'mid-roll', label: 'Mid', name: 'Mid-roll' },
	{ kind: 'post-roll', label: 'Post', name: 'Post-roll' },
	{ kind: 'tail', label: 'Tail', name: 'Tail filler' },
	{ kind: 'fallback', label: 'Fallback', name: 'Channel fallback' },
] as const;

/** One continuous filler break clipped to the visible elapsed-time axis. */
export interface PreviewFillerTick {
	id: string;
	stage: NonNullable<TimelineSegment['fillerStage']>;
	start: string;
	finish: string;
	slotId: string;
	left: number;
	width: number;
}

/** Coalesce adjacent clips from the same stage and occurrence without guessing missing labels. */
export function previewFillerTicks(preview: TimelinePreview | null): PreviewFillerTick[] {
	if (!preview) {
		return [];
	}

	const start = Temporal.PlainDate.from(preview.startDate).toZonedDateTime(preview.timeZone).epochMilliseconds;
	const duration = guideWindowMilliseconds(preview.startDate, preview.days, preview.timeZone);
	const finish = start + duration;
	const ticks: PreviewFillerTick[] = [];
	let previousSegment: TimelineSegment | undefined;
	for (const segment of preview.segments) {
		const clippedStart = Math.max(start, Date.parse(segment.start));
		const clippedFinish = Math.min(finish, Date.parse(segment.finish));
		if (segment.role !== 'filler' || !segment.fillerStage || clippedStart >= clippedFinish) {
			previousSegment = undefined;
			continue;
		}

		const previous = ticks.at(-1);
		if (previous && previousSegment && previous.stage === segment.fillerStage
			&& Date.parse(previousSegment.finish) === Date.parse(segment.start)
			&& previousSegment.slotId === segment.slotId && previousSegment.templateId === segment.templateId
			&& previousSegment.scheduleLayerId === segment.scheduleLayerId
			&& previousSegment.airing?.id === segment.airing?.id) {
			previous.finish = new Date(clippedFinish).toISOString();
			previous.width = (clippedFinish - Date.parse(previous.start)) / duration * 100;
		}
		else {
			ticks.push({ id: segment.id, stage: segment.fillerStage, slotId: segment.slotId,
				start: new Date(clippedStart).toISOString(), finish: new Date(clippedFinish).toISOString(),
				left: (clippedStart - start) / duration * 100, width: (clippedFinish - clippedStart) / duration * 100 });
		}
		previousSegment = segment;
	}
	return ticks;
}
