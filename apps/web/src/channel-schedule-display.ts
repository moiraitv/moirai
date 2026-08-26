import {
	SECONDS_PER_SCHEDULING_DAY,
	type SchedulePredicate,
	type ScheduleSlot,
	type ScheduleTemplate,
} from '@moirai/shared';
import { programColorStyle } from './program-colors';

/** Return a template name while making stale references visible to the operator. */
export function scheduleTemplateName(templates: ScheduleTemplate[], id: string): string {
	return templates.find((template) => template.id === id)?.name ?? 'Missing template';
}

/** Return the stable color of the first program used by a template. */
export function templateRepresentativeStyle(
	templates: ScheduleTemplate[],
	id: string,
): Record<string, string> {
	const template = templates.find((candidate) => candidate.id === id);
	const programId = template?.slots.find((slot) => slot.programId)?.programId ?? null;
	return programColorStyle(programId);
}

/** Size a template slot by its nominal interval and apply its stable program color. */
export function templateSlotStyle(
	template: ScheduleTemplate,
	slot: ScheduleSlot,
): Record<string, string> {
	const end
		= template.boundaries.find((boundary) => boundary.leftSlotId === slot.id)?.targetSeconds
			?? SECONDS_PER_SCHEDULING_DAY;
	return {
		...programColorStyle(slot.programId),
		width: `${(Math.max(0, end - slot.startSeconds) / SECONDS_PER_SCHEDULING_DAY) * 100}%`,
	};
}

/** Summarize one predicate without expanding its full editor controls. */
export function schedulePredicateSummary(predicate: SchedulePredicate): string {
	if (predicate.type === 'all' || predicate.type === 'any') {
		return `${predicate.type === 'all' ? 'All' : 'Any'} of ${predicate.children.length} condition${predicate.children.length === 1 ? '' : 's'}`;
	}

	const prefix = 'negated' in predicate && predicate.negated ? 'Except ' : '';
	switch (predicate.type) {
		case 'months':
			return `${prefix}${predicate.values.length} month${predicate.values.length === 1 ? '' : 's'}`;
		case 'weekdays':
			return `${prefix}${predicate.values.length} weekday${predicate.values.length === 1 ? '' : 's'}`;
		case 'dates':
			return `${prefix}${predicate.values.length} exact date${predicate.values.length === 1 ? '' : 's'}`;
		case 'date-range':
			return `${prefix}${predicate.startDate}–${predicate.endDate}`;
		case 'annual-range':
			return `${prefix}annual range`;
		case 'time-range':
			return `${prefix}daily time range`;
	}
}
