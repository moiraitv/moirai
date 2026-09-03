import type {
	ChannelScheduleConfig,
	ScheduleTemplate,
	TimelineIssue,
	TimelinePreview,
	TimelineSegment,
} from '@moirai/shared';

/** User-facing category for one materialized dead-air interval. */
export type DeadAirCategory = 'authored' | 'boundary' | 'source' | 'filler' | 'unfilled';

/** Exact dead-air interval plus the most useful explanation and editor target. */
export interface DeadAirDiagnostic {
	segment: TimelineSegment;
	durationSeconds: number;
	category: DeadAirCategory;
	label: string;
	explanation: string;
	issue: TimelineIssue | null;
	fillerOrigin: 'channel' | 'template' | 'slot' | null;
	/** A programmed slot can opt out of every inherited filler source. */
	slotFillerDisabled?: boolean;
}

/** Summarize a duration without rounding a short gap down to zero. */
export function schedulingDurationLabel(durationSeconds: number): string {
	const roundedSeconds = Math.max(0, Math.round(durationSeconds));
	if (roundedSeconds < 60) {
		return `${roundedSeconds} second${roundedSeconds === 1 ? '' : 's'}`;
	}

	const minutes = Math.floor(roundedSeconds / 60);
	const seconds = roundedSeconds % 60;
	return seconds === 0
		? `${minutes} minute${minutes === 1 ? '' : 's'}`
		: `${minutes}m ${seconds}s`;
}

/** Identify warnings that explain time lost to boundary resolution. */
function isBoundaryIssue(issue: TimelineIssue): boolean {
	return issue.code === 'boundary-start-rejected' || issue.code === 'slot-displaced';
}

/** Return whether an issue occurrence overlaps a dead-air segment. */
function issueMatchesSegment(issue: TimelineIssue, segment: TimelineSegment): boolean {
	if (
		issue.slotId !== segment.slotId
		|| issue.templateId !== segment.templateId
		|| (!isBoundaryIssue(issue) && issue.scheduleLayerId !== segment.scheduleLayerId)
	) {
		return false;
	}

	const start = Date.parse(segment.start);
	const finish = Date.parse(segment.finish);
	return (issue.occurrences ?? []).some((occurrence) => occurrence.finish
		? Date.parse(occurrence.start) < finish && Date.parse(occurrence.finish) > start
		: Date.parse(occurrence.start) >= start && Date.parse(occurrence.start) < finish);
}

/** Prefer a matching boundary failure, falling back to the first other warning for the gap. */
function issueForSegment(issues: TimelineIssue[], segment: TimelineSegment): TimelineIssue | null {
	let firstMatch: TimelineIssue | null = null;
	for (const issue of issues) {
		if (!issueMatchesSegment(issue, segment)) {
			continue;
		}
		if (isBoundaryIssue(issue)) {
			return issue;
		}
		firstMatch ??= issue;
	}
	return firstMatch;
}

/** Classify one dead-air segment using its authored slot and nearby runtime diagnostics. */
function deadAirDiagnostic(
	segment: TimelineSegment,
	issues: TimelineIssue[],
	templates: ScheduleTemplate[],
	schedule: ChannelScheduleConfig | null,
): DeadAirDiagnostic {
	const issue = issueForSegment(issues, segment);
	const template = templates.find((candidate) => candidate.id === segment.templateId);
	const slot = template?.slots.find((candidate) => candidate.id === segment.slotId);
	const durationSeconds = Math.max(0, (Date.parse(segment.finish) - Date.parse(segment.start)) / 1_000);
	if (slot?.programId === null && schedule?.defaultFiller) {
		return {
			segment,
			durationSeconds,
			category: 'filler',
			label: 'Channel filler could not cover the interval',
			explanation: 'Review channel filler availability and fit policy, or add shorter filler items.',
			issue,
			fillerOrigin: 'channel',
		};
	}
	if (slot?.programId === null) {
		return {
			segment,
			durationSeconds,
			category: 'authored',
			label: 'Authored off-air period',
			explanation: 'This slot intentionally has no program. Assign programming if the channel should remain on air.',
			issue,
			fillerOrigin: null,
		};
	}
	if (issue && isBoundaryIssue(issue)) {
		return {
			segment,
			durationSeconds,
			category: 'boundary',
			label: 'Boundary could not be resolved',
			explanation: issue.message,
			issue,
			fillerOrigin: null,
		};
	}

	const fillerOrigin = slot?.filler.mode === 'configured'
		? 'slot'
		: slot?.filler.mode === 'inherit' && template?.defaultFiller
			? 'template'
			: slot?.filler.mode === 'inherit' && schedule?.defaultFiller
				? 'channel'
				: null;
	const fillerProgramId = fillerOrigin === 'slot' && slot?.filler.mode === 'configured'
		? slot.filler.config.programId
		: fillerOrigin === 'template'
			? template?.defaultFiller?.programId
			: fillerOrigin === 'channel'
				? schedule?.defaultFiller?.programId
				: null;
	if (
		fillerOrigin
		&& issue !== null
		&& issue.programId === fillerProgramId
		&& (issue.code.startsWith('source-') || issue.code.startsWith('media-'))
	) {
		return {
			segment,
			durationSeconds,
			category: 'filler',
			label: 'Filler source needs attention',
			explanation: issue.message,
			issue,
			fillerOrigin,
		};
	}
	if (issue?.code.startsWith('source-') || issue?.code.startsWith('media-')) {
		return {
			segment,
			durationSeconds,
			category: 'source',
			label: 'Program source needs attention',
			explanation: issue.message,
			issue,
			fillerOrigin: null,
		};
	}

	if (fillerOrigin) {
		return {
			segment,
			durationSeconds,
			category: 'filler',
			label: 'Filler could not cover the interval',
			explanation: 'Review filler availability and fit policy, or add shorter filler items.',
			issue,
			fillerOrigin,
		};
	}

	const slotFillerDisabled = slot?.filler.mode === 'disabled';
	return {
		segment,
		durationSeconds,
		category: 'unfilled',
		label: slotFillerDisabled ? 'Slot filler is disabled' : 'No filler configured',
		explanation: slotFillerDisabled
			? 'Enable inherited filler or configure filler for this slot in its template to cover unused time.'
			: 'Configure slot, template, or channel filler to cover unused time.',
		issue,
		fillerOrigin: null,
		slotFillerDisabled,
	};
}

/** Build exact diagnostics for every dead-air interval in a preview. */
export function deadAirDiagnostics(
	preview: TimelinePreview | null,
	templates: ScheduleTemplate[] = [],
	schedule: ChannelScheduleConfig | null = null,
): DeadAirDiagnostic[] {
	if (!preview) {
		return [];
	}

	return preview.segments
		.filter((segment) => segment.role === 'dead-air')
		.map((segment) => deadAirDiagnostic(segment, preview.issues, templates, schedule));
}

/** Return total dead-air seconds across one preview. */
export function totalDeadAirSeconds(preview: TimelinePreview | null): number {
	return deadAirDiagnostics(preview).reduce((total, diagnostic) =>
		total + diagnostic.durationSeconds, 0);
}
