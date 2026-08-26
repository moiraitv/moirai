import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import type { SchedulePredicate } from '@moirai/shared';
import { schedulePredicateMatches } from '@server/scheduling/predicate.js';

describe('schedule predicates', () => {
	it('combines nested groups and negated calendar leaves', () => {
		const predicate: SchedulePredicate = {
			type: 'all',
			children: [
				{ type: 'months', values: [12], negated: false },
				{
					type: 'any',
					children: [
						{ type: 'weekdays', values: [1], negated: false },
						{ type: 'dates', values: ['2026-12-25'], negated: false },
					],
				},
				{ type: 'dates', values: ['2026-12-07'], negated: true },
			],
		};
		expect(
			schedulePredicateMatches(predicate, Temporal.Instant.from('2026-12-14T20:00:00Z'), 'UTC'),
		).toBe(true);
		expect(
			schedulePredicateMatches(predicate, Temporal.Instant.from('2026-12-07T20:00:00Z'), 'UTC'),
		).toBe(false);
		expect(
			schedulePredicateMatches(predicate, Temporal.Instant.from('2026-12-25T20:00:00Z'), 'UTC'),
		).toBe(true);
	});

	it('anchors an overnight range to its starting weekday', () => {
		const predicate: SchedulePredicate = {
			type: 'all',
			children: [
				{ type: 'weekdays', values: [1], negated: false },
				{ type: 'time-range', startSeconds: 22 * 3_600, endSeconds: 2 * 3_600, negated: false },
			],
		};
		expect(
			schedulePredicateMatches(predicate, Temporal.Instant.from('2026-01-06T01:00:00Z'), 'UTC'),
		).toBe(true);
		expect(
			schedulePredicateMatches(predicate, Temporal.Instant.from('2026-01-06T03:00:00Z'), 'UTC'),
		).toBe(false);
	});

	it('does not use a negated overnight range to re-anchor an unrelated calendar branch', () => {
		const predicate: SchedulePredicate = {
			type: 'any',
			children: [
				{ type: 'weekdays', values: [1], negated: false },
				{ type: 'time-range', startSeconds: 22 * 3_600, endSeconds: 2 * 3_600, negated: true },
			],
		};
		expect(
			schedulePredicateMatches(predicate, Temporal.Instant.from('2026-01-06T01:00:00Z'), 'UTC'),
		).toBe(false);
		expect(
			schedulePredicateMatches(predicate, Temporal.Instant.from('2026-01-06T03:00:00Z'), 'UTC'),
		).toBe(true);
	});

	it('keeps overnight anchors inside the matching boolean branch', () => {
		const predicate: SchedulePredicate = {
			type: 'any',
			children: [
				{
					type: 'all',
					children: [
						{ type: 'weekdays', values: [7], negated: false },
						{
							type: 'time-range',
							startSeconds: 22 * 3_600,
							endSeconds: 2 * 3_600,
							negated: false,
						},
					],
				},
				{ type: 'dates', values: ['2026-01-05'], negated: false },
			],
		};

		expect(
			schedulePredicateMatches(predicate, Temporal.Instant.from('2026-01-06T01:00:00Z'), 'UTC'),
		).toBe(false);
	});
});
