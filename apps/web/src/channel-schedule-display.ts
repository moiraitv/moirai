import {
	SECONDS_PER_SCHEDULING_DAY,
	type ChannelScheduleConfig,
	type SchedulePredicate,
	type ScheduleSlot,
	type ScheduleTemplate,
} from '@moirai/shared';
import { countLabel } from './count-label';
import { programColorStyle } from './program-colors';

/** Full month names used by compact scheduling summaries. */
const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
] as const;
/** Full weekday names in the shared Monday-first predicate order. */
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

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

/** Format nominal schedule seconds as a compact twelve-hour time. */
function scheduleTime(seconds: number): { time: string; period: 'AM' | 'PM' } {
	const hours = Math.floor(seconds / 3_600) % 24;
	const minutes = Math.floor((seconds % 3_600) / 60);
	return {
		time: `${hours % 12 || 12}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`,
		period: hours < 12 ? 'AM' : 'PM',
	};
}

/** Format a nominal schedule interval while making next-day boundaries explicit. */
function scheduleTimeRange(startSeconds: number, endSeconds: number): string {
	const start = scheduleTime(startSeconds);
	const end = scheduleTime(endSeconds);
	const wrapsToNextDay = endSeconds <= startSeconds;
	const range = start.period === end.period && !wrapsToNextDay
		? `${start.time}–${end.time} ${end.period}`
		: `${start.time} ${start.period}–${end.time} ${end.period}`;

	return wrapsToNextDay ? `${range} overnight` : range;
}

/** Format one calendar date without applying the browser's local time zone. */
function calendarDate(value: string): string {
	const [year, month, day] = value.split('-').map(Number);
	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)));
}

/** Format one recurring month/day boundary. */
function annualDate(value: { month: number; day: number }): string {
	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(2000, value.month - 1, value.day)));
}

/** Join a short list using natural-language punctuation. */
function compactList(values: string[], conjunction = 'and'): string {
	if (values.length <= 1) {
		return values[0] ?? '';
	}

	if (values.length === 2) {
		return `${values[0]} ${conjunction} ${values[1]}`;
	}

	return `${values.slice(0, -1).join(', ')}, ${conjunction} ${values.at(-1)}`;
}

/** Return whether a predicate is one leaf, allowing transparent single-child groups. */
function simplePredicate(predicate: SchedulePredicate): SchedulePredicate | null {
	if (predicate.type !== 'all' && predicate.type !== 'any') {
		return predicate;
	}

	return predicate.children.length === 1 ? simplePredicate(predicate.children[0]!) : null;
}

/** Prefix a leaf summary when the condition excludes rather than includes its values. */
function withExclusion(predicate: SchedulePredicate, summary: string): string {
	return 'negated' in predicate && predicate.negated ? `Except ${summary}` : summary;
}

/** Summarize one predicate without expanding its full editor controls. */
export function schedulePredicateSummary(predicate: SchedulePredicate): string {
	if (predicate.type === 'all' || predicate.type === 'any') {
		if (predicate.children.length === 1) {
			return schedulePredicateSummary(predicate.children[0]!);
		}

		if (
			predicate.children.length === 2
			&& predicate.children.every((child) => simplePredicate(child) !== null)
		) {
			return compactList(
				predicate.children.map((child) => schedulePredicateSummary(child)),
				predicate.type === 'all' ? 'and' : 'or',
			);
		}

		return countLabel(
			predicate.children.length,
			predicate.type === 'all' ? 'combined condition' : 'alternate condition',
		);
	}

	switch (predicate.type) {
		case 'months': {
			const summary = predicate.values.length === 12
				? 'all year'
				: predicate.values.length <= 3
					? compactList(predicate.values.map((value) => MONTH_NAMES[value - 1]!))
					: countLabel(predicate.values.length, 'month');
			return withExclusion(predicate, summary);
		}
		case 'weekdays': {
			const values = predicate.values;
			const summary = values.length === 7
				? 'every day'
				: values.join(',') === '1,2,3,4,5'
					? 'weekdays'
					: values.join(',') === '6,7'
						? 'weekends'
						: values.length <= 3
							? compactList(values.map((value) => `${WEEKDAY_NAMES[value - 1]}s`))
							: countLabel(values.length, 'weekday');
			return withExclusion(predicate, summary);
		}
		case 'dates': {
			const summary = predicate.values.length <= 2
				? compactList(predicate.values.map(calendarDate))
				: countLabel(predicate.values.length, 'exact date');
			return withExclusion(predicate, summary);
		}
		case 'date-range':
			return withExclusion(
				predicate,
				`${calendarDate(predicate.startDate)}–${calendarDate(predicate.endDate)}`,
			);
		case 'annual-range':
			return withExclusion(
				predicate,
				`${annualDate(predicate.start)}–${annualDate(predicate.end)} annually`,
			);
		case 'time-range':
			return withExclusion(
				predicate,
				`${scheduleTimeRange(predicate.startSeconds, predicate.endSeconds)} timeslot`,
			);
	}
}

/** Express one simple predicate as a clause following a template name. */
function schedulePredicateClause(predicate: SchedulePredicate): string | null {
	const simple = simplePredicate(predicate);
	if (!simple) {
		return null;
	}
	if ('negated' in simple && simple.negated) {
		return `except ${schedulePredicateSummary({ ...simple, negated: false })}`;
	}

	switch (simple.type) {
		case 'time-range':
			return `from ${scheduleTimeRange(simple.startSeconds, simple.endSeconds)}`;
		case 'weekdays':
			if (simple.values.length === 7) {
				return 'every day';
			}

			return `on ${schedulePredicateSummary(simple)}`;
		case 'months':
			if (simple.values.length === 12) {
				return 'all year';
			}

			return `during ${schedulePredicateSummary(simple)}`;
		case 'dates':
			return `on ${schedulePredicateSummary(simple)}`;
		case 'date-range':
		case 'annual-range':
			return `during ${schedulePredicateSummary(simple)}`;
		case 'all':
		case 'any':
			return null;
	}
}

/** Summarize a channel's base and conditional templates without expanding a full predicate tree. */
export function channelScheduleSummary(
	schedule: Pick<ChannelScheduleConfig, 'defaultTemplateId' | 'layers'> | null | undefined,
	templates: ScheduleTemplate[],
): string {
	if (!schedule) {
		return 'No schedule configured';
	}

	const base = scheduleTemplateName(templates, schedule.defaultTemplateId);
	if (schedule.layers.length === 0) {
		return base;
	}

	if (schedule.layers.length === 1) {
		const layer = schedule.layers[0]!;
		const clause = schedulePredicateClause(layer.predicate);
		return `${base} with ${scheduleTemplateName(templates, layer.templateId)}${clause ? ` ${clause}` : ''}`;
	}

	if (schedule.layers.length === 2) {
		return `${base} with ${compactList(
			schedule.layers.map((layer) => scheduleTemplateName(templates, layer.templateId)),
		)}`;
	}

	return `${base} with ${countLabel(schedule.layers.length, 'conditional template')}`;
}
