import type { DeadAirDiagnostic } from './schedule-diagnostics';

/** Concrete editor destination selected from a gap's cause, not merely its effective layer. */
export type DeadAirAction
	= | { type: 'program'; programId: string; label: string }
		| { type: 'channel-filler'; label: string }
		| { type: 'template'; templateId: string; label: string }
		| { type: 'layer-boundary'; layerId: string; origin: 'layer-entry' | 'layer-exit'; label: string };

/** Select a cause-specific action using the occurrence that overlaps this exact gap. */
export function deadAirAction(diagnostic: DeadAirDiagnostic): DeadAirAction {
	const { issue, segment, category } = diagnostic;
	const occurrence = issue?.occurrences?.find((entry) => entry.finish
		? Date.parse(entry.start) < Date.parse(segment.finish) && Date.parse(entry.finish) > Date.parse(segment.start)
		: Date.parse(entry.start) >= Date.parse(segment.start) && Date.parse(entry.start) < Date.parse(segment.finish));
	const origin = occurrence?.boundaryOrigin;
	if (category === 'boundary' && issue?.scheduleLayerId
		&& (origin === 'layer-entry' || origin === 'layer-exit')) {
		return {
			type: 'layer-boundary',
			layerId: issue.scheduleLayerId,
			origin,
			label: origin === 'layer-entry' ? 'Review entry boundary' : 'Review exit boundary',
		};
	}
	if (category === 'source' && issue?.programId) {
		return { type: 'program', programId: issue.programId, label: 'Edit program' };
	}
	if (diagnostic.fillerOrigin === 'channel' || (category === 'unfilled' && !diagnostic.slotFillerDisabled)) {
		return { type: 'channel-filler', label: 'Review channel filler' };
	}
	return {
		type: 'template',
		templateId: segment.templateId,
		label: category === 'boundary'
			? 'Review template boundary'
			: category === 'filler' || diagnostic.slotFillerDisabled ? 'Review filler' : 'Review template',
	};
}
