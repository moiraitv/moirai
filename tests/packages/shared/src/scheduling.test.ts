import { describe, expect, it } from 'vitest';
import {
	boundedSchedulePredicateSchema,
	channelScheduleConfigSchema,
	MAX_CHANNEL_SCHEDULE_LAYERS,
	MAX_EXPLICIT_MEDIA_GROUPS,
	MAX_SCHEDULE_PREDICATE_DEPTH,
	layerBoundarySchema,
	programConfigSchema,
	scheduleBoundarySchema,
	scheduleSlotSchema,
	type SchedulePredicate,
} from '@shared-source/scheduling.js';

const uuid = (value: number): string =>
	`00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

function nestedPredicate(depth: number): SchedulePredicate {
	let predicate: SchedulePredicate = {
		type: 'weekdays',
		values: [1],
		negated: false,
	};
	for (let index = 1; index < depth; index += 1) {
		predicate = { type: 'all', children: [predicate] };
	}
	return predicate;
}

describe('layered schedule contracts', () => {
	it('requires no-program slots to disable their unused filler configuration', () => {
		const slot = {
			id: uuid(1),
			startSeconds: 0,
			programId: null,
			stateScope: 'persistent',
			startEligibility: { type: 'require-fit' },
		};
		expect(scheduleSlotSchema.safeParse({ ...slot, filler: { mode: 'disabled' } }).success).toBe(
			true,
		);
		expect(scheduleSlotSchema.safeParse({ ...slot, filler: { mode: 'inherit' } }).success).toBe(
			false,
		);
	});

	it('accepts a bounded unique selection of shows or seasons', () => {
		const config = {
			type: 'content' as const,
			source: {
				type: 'group-collection' as const,
				libraryId: uuid(1),
				groupIds: Array.from({ length: MAX_EXPLICIT_MEDIA_GROUPS }, (_, index) => uuid(index + 2)),
			},
			strategy: { type: 'sequential' as const },
		};
		expect(programConfigSchema.safeParse(config).success).toBe(true);
		expect(
			programConfigSchema.safeParse({
				...config,
				source: { ...config.source, groupIds: [...config.source.groupIds, uuid(999)] },
			}).success,
		).toBe(false);
		expect(
			programConfigSchema.safeParse({
				...config,
				source: { ...config.source, groupIds: [uuid(2), uuid(2)] },
			}).success,
		).toBe(false);
	});

	it('allows unlimited drift only when finishing outgoing content', () => {
		const templateBoundary = {
			id: uuid(10),
			leftSlotId: uuid(11),
			rightSlotId: uuid(12),
			targetSeconds: 3_600,
			policy: 'finish-left' as const,
			maxDriftSeconds: null,
			fallback: 'reject-start' as const,
		};
		expect(scheduleBoundarySchema.safeParse(templateBoundary).success).toBe(true);
		expect(scheduleBoundarySchema.safeParse({ ...templateBoundary, policy: 'hard' }).success).toBe(
			false,
		);
		expect(
			layerBoundarySchema.safeParse({
				policy: 'finish-left',
				maxDriftSeconds: null,
				fallback: 'truncate-left',
			}).success,
		).toBe(true);
		expect(
			layerBoundarySchema.safeParse({
				policy: 'favor-right',
				maxDriftSeconds: null,
				fallback: 'truncate-left',
			}).success,
		).toBe(false);
	});

	it('rejects impossible recurring calendar dates and excessive predicate depth', () => {
		expect(
			boundedSchedulePredicateSchema.safeParse({
				type: 'annual-range',
				start: { month: 4, day: 31 },
				end: { month: 12, day: 31 },
				negated: false,
			}).success,
		).toBe(false);
		expect(
			boundedSchedulePredicateSchema.safeParse(nestedPredicate(MAX_SCHEDULE_PREDICATE_DEPTH))
				.success,
		).toBe(true);
		expect(
			boundedSchedulePredicateSchema.safeParse(nestedPredicate(MAX_SCHEDULE_PREDICATE_DEPTH + 1))
				.success,
		).toBe(false);
	});

	it('bounds the number of conditional templates on one channel', () => {
		const layers = Array.from({ length: MAX_CHANNEL_SCHEDULE_LAYERS + 1 }, (_, index) => ({
			id: uuid(100 + index),
			templateId: uuid(1),
			predicate: { type: 'months' as const, values: [1], negated: false },
			entryBoundary: {
				policy: 'hard' as const,
				maxDriftSeconds: 0,
				fallback: 'truncate-left' as const,
			},
			exitBoundary: {
				policy: 'hard' as const,
				maxDriftSeconds: 0,
				fallback: 'truncate-left' as const,
			},
		}));
		expect(
			channelScheduleConfigSchema.safeParse({
				defaultTemplateId: uuid(1),
				layers,
				defaultFiller: null,
			}).success,
		).toBe(false);
	});

	it('canonicalizes set-like queries and predicates without changing authored collections', () => {
		const config = programConfigSchema.parse({
			type: 'content',
			source: {
				type: 'library-query',
				libraryId: uuid(1),
				kinds: [' Movie ', 'movie', 'Episode'],
				genres: ['Sci-Fi', 'Science Fiction', 'Drama'],
			},
			strategy: { type: 'sequential' },
		});
		expect(config).toMatchObject({
			source: {
				kinds: ['episode', 'movie'],
				genres: ['drama', 'science-fiction'],
			},
		});
		const predicate = boundedSchedulePredicateSchema.parse({
			type: 'weekdays',
			values: [5, 1, 5, 2],
			negated: false,
		});
		expect(predicate).toMatchObject({ values: [1, 2, 5] });
	});

	it('rejects duplicate sequence entry identifiers', () => {
		const entry = { id: uuid(10), programId: uuid(11), count: 1 };
		expect(programConfigSchema.safeParse({
			type: 'sequence',
			entries: [entry, { ...entry, programId: uuid(12) }],
			repeat: true,
		}).success).toBe(false);
	});
});
