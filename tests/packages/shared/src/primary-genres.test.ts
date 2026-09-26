import { expect, it } from 'vitest';
import { catalogProgramItemFilterSchema, MAX_MEDIA_GENRE_RULES } from '@moirai/shared';

it('keeps saved sport rules compatible and rejects contradictory sport aliases', () => {
	for (const field of ['genres', 'primaryGenres', 'excludedGenres'] as const) {
		expect(catalogProgramItemFilterSchema.parse({ [field]: ['Sport', 'sports'] })[field]).toEqual(['sports']);
	}
	for (const rules of [
		{ primaryGenres: ['sport'], genres: ['sports'] },
		{ genres: ['sport'], excludedGenres: ['sports'] },
		{ primaryGenres: ['sport'], excludedGenres: ['sports'] },
	]) {
		expect(catalogProgramItemFilterSchema.safeParse(rules).success).toBe(false);
	}
});

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
