import { describe, expect, it } from 'vitest';
import { BUILTIN_MID_ROLL_PRESETS, DEFAULT_MID_ROLL_PREDICATE, defaultMidRollConfig, matchesMidRollPredicate,
	midRollConfigSchema, midRollPredicateSchema, midRollSettingsSchema, type MidRollFacts, type MidRollPredicate,
	MAX_MID_ROLL_PREDICATE_NODES, MAX_MID_ROLL_PREDICATE_DEPTH } from '@moirai/shared';

const facts: MidRollFacts = { point: 600, num: 2, total_duration: 1800, total_progress: 1 / 3,
	remaining_duration: 1200, total_points: 4, matched_points: 0, last_mid_filler: 600, title: 'Act 1' };

describe('guided mid-roll predicates', () => {
	it('matches the default spacing rule at its inclusive boundaries', () => {
		expect(matchesMidRollPredicate(DEFAULT_MID_ROLL_PREDICATE, facts)).toBe(true);
		for (const [field, value] of [['point', 599], ['last_mid_filler', 599], ['remaining_duration', 119]] as const) {
			expect(matchesMidRollPredicate(DEFAULT_MID_ROLL_PREDICATE, { ...facts, [field]: value })).toBe(false);
		}
	});

	it('combines nested groups, exact titles, intervals and exclusions', () => {
		const rule: MidRollPredicate = { type: 'all', children: [
			{ type: 'any', children: [{ type: 'every-nth', interval: 2, remainder: 0, negated: false },
				{ type: 'number', field: 'total_progress', operator: 'gt', value: 0.5, negated: false }] },
			{ type: 'title', value: 'Credits', negated: true },
		] };
		expect(matchesMidRollPredicate(rule, facts)).toBe(true);
		expect(matchesMidRollPredicate(rule, { ...facts, num: 3 })).toBe(false);
		expect(matchesMidRollPredicate(rule, { ...facts, title: 'Credits' })).toBe(false);
		expect(matchesMidRollPredicate(rule, { ...facts, title: 'credits' })).toBe(true);
	});

	it.each([['eq', true], ['ne', false], ['gt', false], ['gte', true], ['lt', false], ['lte', true]] as const)('evaluates %s without authored code', (operator, expected) => {
		expect(matchesMidRollPredicate({ type: 'number', field: 'point', operator, value: facts.point, negated: false }, facts)).toBe(expected);
	});

	it('bounds trees and rejects unsupported expression or numeric input', () => {
		const always: MidRollPredicate = { type: 'always', negated: false };
		expect(midRollPredicateSchema.safeParse({ type: 'all', children: Array.from({ length: MAX_MID_ROLL_PREDICATE_NODES }, () => always) }).success).toBe(false);
		let rule: MidRollPredicate = always;
		for (let depth = 0; depth < MAX_MID_ROLL_PREDICATE_DEPTH; depth += 1) {
			rule = { type: 'all', children: [rule] };
		}
		expect(midRollPredicateSchema.safeParse(rule).success).toBe(false);
		expect(midRollPredicateSchema.safeParse({ type: 'expression', expression: 'true' }).success).toBe(false);
		expect(midRollPredicateSchema.safeParse({ type: 'every-nth', interval: 2, remainder: 2 }).success).toBe(false);
		expect(midRollPredicateSchema.safeParse({ type: 'number', field: 'point', operator: 'eq', value: Infinity }).success).toBe(false);
	});

	it('validates built-in budgets and explicit assignments', () => {
		for (const preset of BUILTIN_MID_ROLL_PRESETS) {
			expect(midRollSettingsSchema.safeParse(preset).success).toBe(true);
		}
		expect(midRollConfigSchema.safeParse(defaultMidRollConfig('00000000-0000-4000-8000-000000000001')).success).toBe(true);
		expect(midRollSettingsSchema.safeParse({ ...BUILTIN_MID_ROLL_PRESETS[0], budget: { type: 'count', count: 0 } }).success).toBe(false);
	});
});
