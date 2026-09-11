import { Temporal } from '@js-temporal/polyfill';
import type { ScheduleTemplate, SchedulingProgram, TimelinePreview, TimelineSegment } from '@moirai/shared';
import type { TimelineGeneration } from '../scheduling/engine.js';
import { publicTimelineIssue } from '../scheduling/timeline-issues.js';
import { projectGuideEntries } from './projection.js';

/** Include each referenced source name once, without exposing program configuration. */
export function guideProgramNames(segments: TimelineSegment[], names: ReadonlyMap<string, string>): Record<string, string> {
	return Object.fromEntries([...new Set(segments.flatMap(segment => segment.role === 'primary' && segment.programId ? [segment.programId] : []))]
		.flatMap(id => names.has(id) ? [[id, names.get(id)!]] : []));
}

/** Present a generated draft using the same slot boundaries and titles as the committed guide. */
export function guideTimelinePreview(
	generated: TimelineGeneration,
	templates: ScheduleTemplate[],
	programs: SchedulingProgram[],
): TimelinePreview {
	const names = new Map(programs.map(program => [program.id, program.name]));
	const date = Temporal.PlainDate.from(generated.startDate);
	const start = date.toZonedDateTime(generated.timeZone).toInstant().toString();
	const finish = date.add({ days: generated.days }).toZonedDateTime(generated.timeZone).toInstant().toString();
	return {
		channelId: generated.channelId, timeZone: generated.timeZone,
		startDate: generated.startDate, days: generated.days,
		programNames: guideProgramNames(generated.segments, names),
		segments: generated.segments, proposedState: generated.proposedState,
		issues: generated.issues.map(publicTimelineIssue),
		entries: projectGuideEntries(
			generated.channelId, 
			generated.segments, 
			generated.guideOccurrences, 
			templates, 
			start, 
			finish,
			names,
		),
	};
}
