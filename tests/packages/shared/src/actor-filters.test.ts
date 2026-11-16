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

describe('top-billed actor filter contracts', () => {
	it('accepts legacy filters and explicit boolean flags everywhere filters are shared', () => {
		for (const parse of contracts) {
			for (const input of [{}, { actor: 'Guest' }, { actor: 'Guest', actorTopBilledOnly: true }, { actorTopBilledOnly: false }]) {
				expect(parse(input).success).toBe(true);
			}
			for (const actorTopBilledOnly of ['true', 'false', 1, null]) {
				expect(parse({ actorTopBilledOnly }).success).toBe(false);
			}
		}
	});

	it('preserves the flag in parsed persistence and preview contracts', () => {
		for (const parse of contracts) {
			const result = parse({ actor: 'Guest', actorTopBilledOnly: true });
			expect(result.success).toBe(true);
			if (result.success) {
				const data = result.data;
				const filter = 'source' in data ? data.source : 'filter' in data ? data.filter : data;
				expect(filter).toMatchObject({ actor: 'Guest', actorTopBilledOnly: true });
			}
		}
	});
});
