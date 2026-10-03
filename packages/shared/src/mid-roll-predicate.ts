import { z } from 'zod';

/** Numeric source-content facts available at each candidate break. */
export const MID_ROLL_NUMERIC_FIELDS = ['total_points', 'matched_points', 'total_duration', 'total_progress',
	'remaining_duration', 'point', 'num', 'last_mid_filler'] as const;
/** Bound editor and evaluator work for one authored rule. */
export const MAX_MID_ROLL_PREDICATE_NODES = 100;
/** Limit nested groups to keep rules understandable and evaluation bounded. */
export const MAX_MID_ROLL_PREDICATE_DEPTH = 8;
/** Facts measured before inserting filler; point numbers start at one. */
export type MidRollFacts = Record<typeof MID_ROLL_NUMERIC_FIELDS[number], number> & { title: string };
/** Typed conditions authored through the guided break editor. */
export type MidRollPredicate
	= | { type: 'all'; children: MidRollPredicate[] }
		| { type: 'any'; children: MidRollPredicate[] }
		| { type: 'always'; negated: boolean }
		| { type: 'number'; field: typeof MID_ROLL_NUMERIC_FIELDS[number]; operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; value: number; negated: boolean }
		| { type: 'every-nth'; interval: number; remainder: number; negated: boolean }
		| { type: 'title'; value: string; negated: boolean };

/** Recursive shape, refined below with aggregate resource limits. */
const predicateShape: z.ZodType<MidRollPredicate> = z.lazy(() => z.union([
	z.object({ type: z.enum(['all', 'any']), children: z.array(predicateShape).min(1).max(MAX_MID_ROLL_PREDICATE_NODES) }),
	z.object({ type: z.literal('always'), negated: z.boolean().default(false) }),
	z.object({ type: z.literal('number'), field: z.enum(MID_ROLL_NUMERIC_FIELDS),
		operator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']), value: z.number().min(0), negated: z.boolean().default(false) })
		.refine(value => value.field !== 'total_progress' || value.value <= 1, 'Progress must be between zero and 100 percent'),
	z.object({ type: z.literal('every-nth'), interval: z.number().int().min(1).max(256),
		remainder: z.number().int().min(0), negated: z.boolean().default(false) })
		.refine(value => value.remainder < value.interval, 'Remainder must be smaller than the interval'),
	z.object({ type: z.literal('title'), value: z.string().max(512), negated: z.boolean().default(false) }),
]));

/** Count nested nodes without evaluating their content. */
function size(predicate: MidRollPredicate, depth = 1): { nodes: number; depth: number } {
	if (predicate.type !== 'all' && predicate.type !== 'any') {
		return { nodes: 1, depth };
	}
	return predicate.children.reduce((result, child) => {
		const next = size(child, depth + 1);
		return { nodes: result.nodes + next.nodes, depth: Math.max(result.depth, next.depth) };
	}, { nodes: 1, depth });
}

/** Validate guided conditions and bound their combined complexity. */
export const midRollPredicateSchema = predicateShape.superRefine((predicate, context) => {
	const count = size(predicate);
	if (count.nodes > MAX_MID_ROLL_PREDICATE_NODES || count.depth > MAX_MID_ROLL_PREDICATE_DEPTH) {
		context.addIssue({ code: 'custom', message: 'Break conditions allow at most 100 nodes and eight levels' });
	}
});
z.globalRegistry.add(predicateShape, { id: 'MidRollPredicate', description: 'Guided conditions evaluated against source-content break facts.' });

/** Evaluate a validated rule without running authored code or changing matched-point state. */
export function matchesMidRollPredicate(predicate: MidRollPredicate, facts: MidRollFacts): boolean {
	if (predicate.type === 'all' || predicate.type === 'any') {
		return predicate.type === 'all' ? predicate.children.every(child => matchesMidRollPredicate(child, facts))
			: predicate.children.some(child => matchesMidRollPredicate(child, facts));
	}
	let matched: boolean;
	if (predicate.type === 'always') {
		matched = true;
	}
	else if (predicate.type === 'title') {
		matched = facts.title === predicate.value;
	}
	else if (predicate.type === 'every-nth') {
		matched = facts.num % predicate.interval === predicate.remainder;
	}
	else {
		const actual = facts[predicate.field];
		switch (predicate.operator) {
			case 'eq': matched = actual === predicate.value;
				break;
			case 'ne': matched = actual !== predicate.value;
				break;
			case 'gt': matched = actual > predicate.value;
				break;
			case 'gte': matched = actual >= predicate.value;
				break;
			case 'lt': matched = actual < predicate.value;
				break;
			case 'lte': matched = actual <= predicate.value;
				break;
		}
	}
	return predicate.negated ? !matched : matched;
}

/** Protect the opening, spacing between accepted points, and final two minutes. */
export const DEFAULT_MID_ROLL_PREDICATE: MidRollPredicate = { type: 'all', children: [
	{ type: 'number', field: 'point', operator: 'gte', value: 600, negated: false },
	{ type: 'number', field: 'last_mid_filler', operator: 'gte', value: 600, negated: false },
	{ type: 'number', field: 'remaining_duration', operator: 'gte', value: 120, negated: false },
] };
