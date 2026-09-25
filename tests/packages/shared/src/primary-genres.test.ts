import { expect, it } from 'vitest';
import { catalogProgramItemFilterSchema, MAX_MEDIA_GENRE_RULES } from '@moirai/shared';

it('normalizes primary rules, defaults legacy filters, and rejects conflicting or oversized rules', () => {
	expect(catalogProgramItemFilterSchema.parse({}).primaryGenres).toEqual([]);
	expect(catalogProgramItemFilterSchema.parse({ primaryGenres: [' Drama ', 'drama'] }).primaryGenres).toEqual(['drama']);
	for (const rules of [
		{ primaryGenres: ['drama'], genres: ['Drama'] },
		{ primaryGenres: ['drama'], excludedGenres: ['Drama'] },
		{ primaryGenres: ['drama'], excludedGenres: ['horror'], genreMatch: 'any' },
		{ primaryGenres: ['drama'], genres: Array.from({ length: MAX_MEDIA_GENRE_RULES }, (_, i) => `genre-${i}`) },
	]) {
		expect(catalogProgramItemFilterSchema.safeParse(rules).success).toBe(false);
	}
});
