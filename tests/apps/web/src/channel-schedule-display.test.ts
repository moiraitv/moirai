import { describe, expect, it } from 'vitest';
import type { ChannelScheduleConfig, SchedulePredicate, ScheduleTemplate } from '@moirai/shared';
import {
	channelScheduleSummary,
	schedulePredicateSummary,
} from '@web/channel-schedule-display.js';

/** Provide the template identity used by schedule summaries without irrelevant slot fixture detail. */
function template(id: string, name: string): ScheduleTemplate {
	return { id, name } as ScheduleTemplate;
}

/** Provide the schedule fields consumed by the summary helper. */
function schedule(
	defaultTemplateId: string,
	layers: Array<{ templateId: string; predicate: SchedulePredicate }>,
): ChannelScheduleConfig {
	return {
		defaultTemplateId,
		defaultFiller: null,
		layers: layers.map((layer, index) => ({
			id: `00000000-0000-4000-8000-00000000000${index}`,
			...layer,
			entryBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left' },
			exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left' },
		})),
	};
}

const weekdays: SchedulePredicate = {
	type: 'weekdays',
	values: [1, 2, 3, 4, 5],
	negated: false,
};
const timeslot: SchedulePredicate = {
	type: 'time-range',
	startSeconds: 17 * 3_600,
	endSeconds: 22 * 3_600,
	negated: false,
};

describe('schedule predicate summaries', () => {
	it('describes common calendar and time leaves', () => {
		expect(schedulePredicateSummary(weekdays)).toBe('weekdays');
		expect(schedulePredicateSummary({ ...weekdays, values: [5] })).toBe('Fridays');
		expect(schedulePredicateSummary({ ...weekdays, values: [6, 7] })).toBe('weekends');
		expect(schedulePredicateSummary({ type: 'months', values: [1, 3], negated: false }))
			.toBe('January and March');
		expect(schedulePredicateSummary(timeslot)).toBe('5–10 PM timeslot');
	});

	it('makes overnight time ranges explicit without collapsing repeated meridiems', () => {
		expect(schedulePredicateSummary({
			type: 'time-range',
			startSeconds: 23 * 3_600,
			endSeconds: 22 * 3_600,
			negated: false,
		})).toBe('11 PM–10 PM overnight timeslot');
		expect(schedulePredicateSummary({
			type: 'time-range',
			startSeconds: 22 * 3_600,
			endSeconds: 2 * 3_600,
			negated: false,
		})).toBe('10 PM–2 AM overnight timeslot');
	});

	it('describes dates, recurring ranges, and exclusions', () => {
		expect(schedulePredicateSummary({
			type: 'dates',
			values: ['2026-01-02'],
			negated: false,
		})).toContain('Jan 2, 2026');
		expect(schedulePredicateSummary({
			type: 'annual-range',
			start: { month: 10, day: 1 },
			end: { month: 10, day: 31 },
			negated: false,
		})).toBe('Oct 1–Oct 31 annually');
		expect(schedulePredicateSummary({ ...timeslot, negated: true }))
			.toBe('Except 5–10 PM timeslot');
	});

	it('unwraps one-child groups, joins small groups, and condenses complex groups', () => {
		expect(schedulePredicateSummary({ type: 'all', children: [timeslot] }))
			.toBe('5–10 PM timeslot');
		expect(schedulePredicateSummary({ type: 'all', children: [weekdays, timeslot] }))
			.toBe('weekdays and 5–10 PM timeslot');
		expect(schedulePredicateSummary({
			type: 'any',
			children: [weekdays, timeslot, { type: 'months', values: [12], negated: false }],
		})).toBe('3 alternate conditions');
	});
});

describe('channel schedule summaries', () => {
	const templates = [
		template('base', 'Sci-Fi Movie Loop'),
		template('heroes', 'Superhero Movie Loop'),
		template('feature', 'Friday Feature'),
		template('late', 'Late Night'),
	];

	it('describes absent and base-only schedules', () => {
		expect(channelScheduleSummary(null, templates)).toBe('No schedule configured');
		expect(channelScheduleSummary(schedule('base', []), templates)).toBe('Sci-Fi Movie Loop');
	});

	it('adds a concise condition for one simple conditional layer', () => {
		expect(channelScheduleSummary(schedule('base', [{ templateId: 'heroes', predicate: timeslot }]), templates))
			.toBe('Sci-Fi Movie Loop with Superhero Movie Loop from 5–10 PM');
	});

	it('uses natural clauses for whole-week and whole-year conditions', () => {
		expect(channelScheduleSummary(schedule('base', [{
			templateId: 'heroes',
			predicate: { type: 'weekdays', values: [1, 2, 3, 4, 5, 6, 7], negated: false },
		}]), templates)).toBe('Sci-Fi Movie Loop with Superhero Movie Loop every day');
		expect(channelScheduleSummary(schedule('base', [{
			templateId: 'heroes',
			predicate: {
				type: 'months',
				values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
				negated: false,
			},
		}]), templates)).toBe('Sci-Fi Movie Loop with Superhero Movie Loop all year');
	});

	it('retains a simple excluded condition in a channel summary', () => {
		expect(channelScheduleSummary(schedule('base', [{
			templateId: 'heroes',
			predicate: { ...weekdays, negated: true },
		}]), templates)).toBe('Sci-Fi Movie Loop with Superhero Movie Loop except weekdays');
	});

	it('lists two layers and condenses larger stacks', () => {
		expect(channelScheduleSummary(schedule('base', [
			{ templateId: 'heroes', predicate: timeslot },
			{ templateId: 'feature', predicate: weekdays },
		]), templates)).toBe('Sci-Fi Movie Loop with Superhero Movie Loop and Friday Feature');
		expect(channelScheduleSummary(schedule('base', [
			{ templateId: 'heroes', predicate: timeslot },
			{ templateId: 'feature', predicate: weekdays },
			{ templateId: 'late', predicate: timeslot },
		]), templates)).toBe('Sci-Fi Movie Loop with 3 conditional templates');
	});
});
