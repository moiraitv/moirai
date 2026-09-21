import { describe, expect, it } from 'vitest';
import { catalogProgramItemFilterSchema, catalogProgramItemQuerySchema, programConfigSchema, quickChannelSourceSchema, quickChannelQueryPreviewRequestSchema, similarityProgramConfigSchema } from '@moirai/shared';

const libraryId = '00000000-0000-4000-8000-000000000001';
const contracts = [
	(input: object) => catalogProgramItemFilterSchema.safeParse(input),
	(input: object) => catalogProgramItemQuerySchema.safeParse(input),
	(input: object) => programConfigSchema.safeParse({ type: 'content', source: { type: 'library-query', libraryId, kinds: [], ...input }, strategy: { type: 'sequential' } }),
	(input: object) => quickChannelSourceSchema.safeParse({ type: 'library-query', ...input }),
	(input: object) => quickChannelQueryPreviewRequestSchema.safeParse({ scenario: 'movies', libraryId, ...input }),
	(input: object) => similarityProgramConfigSchema.safeParse({ type: 'similarity', sourceProgramId: libraryId, filter: input }),
];

describe('shared duration bound contracts', () => {
	it('accepts legacy, open, zero, equal, and long ranges across every filter contract', () => {
		for (const parse of contracts) {
			for (const input of [{}, { minimumDurationSeconds: null }, { maximumDurationSeconds: 0 }, { minimumDurationSeconds: 60, maximumDurationSeconds: 60 }, { minimumDurationSeconds: 90061 }]) {
				expect(parse(input).success).toBe(true);
			}
		}
	});
	it('rejects invalid and reversed bounds across every filter contract', () => {
		for (const parse of contracts) {
			for (const input of [{ minimumDurationSeconds: -1 }, { maximumDurationSeconds: 1.5 }, { minimumDurationSeconds: Number.MAX_SAFE_INTEGER + 1 }, { minimumDurationSeconds: 61, maximumDurationSeconds: 60 }]) {
				expect(parse(input).success).toBe(false);
			}
		}
	});
});
