import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, it } from 'vitest';
import { catalogProgramItemQuerySchema, libraryCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';

it('matches primary rules and predicts every replacement action using actual catalog results', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const library = await repository.createLibrary(libraryCreateSchema.parse({
			name: 'Primary genres', typeKey: 'movies', sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/media', playbackRoot: '/media' },
		}));
		const candidates = [
			{ id: 'one', primary: 'comedy', genres: ['comedy', 'drama'] },
			{ id: 'two', primary: 'drama', genres: ['comedy', 'drama'] },
			{ id: 'three', primary: 'horror', genres: ['horror'] },
			{ id: 'unknown', primary: null, genres: ['drama'] },
			{ id: 'empty', primary: null, genres: [] },
		];
		for (const candidate of candidates) {
			database.sqlite.prepare(`INSERT INTO media_items
				(id, library_id, stable_key, kind, title, sort_title, relative_path, playback_path,
				 metadata_status, metadata, fingerprint, primary_genre_key)
				VALUES (?, ?, ?, 'movie', ?, ?, ?, ?, 'complete', '{}', 'fixture', ?)`)
				.run(candidate.id, library.id, candidate.id, candidate.id, candidate.id, candidate.id, candidate.id, candidate.primary);
			for (const genre of candidate.genres) {
				database.sqlite.prepare('INSERT INTO media_item_genres (item_id, library_id, genre_key, genre_name) VALUES (?, ?, ?, ?)')
					.run(candidate.id, library.id, genre, genre);
			}
		}
		const browse = async (rules: Record<string, unknown>) => repository.browseMedia(library.id, {
			...catalogProgramItemQuerySchema.parse(rules), page: 1, pageSize: 50,
		});
		expect((await browse({ primaryGenres: ['comedy'] })).items.map(item => item.id)).toEqual(['one']);
		expect((await browse({ primaryGenres: ['comedy'], genres: ['drama'] })).items.map(item => item.id)).toEqual(['one']);
		expect((await browse({ primaryGenres: ['comedy', 'drama'] })).items).toEqual([]);
		expect((await browse({ primaryGenres: ['comedy', 'drama'], genreMatch: 'any' })).items.map(item => item.id)).toEqual(['one', 'two']);
		expect((await browse({ primaryGenres: ['comedy'], genres: ['horror'], genreMatch: 'any' })).items.map(item => item.id)).toEqual(['one', 'three']);
		expect((await browse({ primaryGenres: ['comedy'], excludedGenres: ['drama'] })).items).toEqual([]);

		// Cover neutral rules, switching all three states, and several incompatible primary rules.
		for (const selection of [
			{ genres: [], primaryGenres: [], excludedGenres: [] },
			{ genres: ['drama'], primaryGenres: ['comedy'], excludedGenres: ['horror'] },
			{ genres: [], primaryGenres: ['comedy', 'drama'], excludedGenres: [] },
			{ genres: [], primaryGenres: [], excludedGenres: ['comedy', 'drama'] },
		]) {
			const facets = await repository.listMediaGenres(library.id, selection);
			for (const facet of facets) {
				for (const [field, count] of [['genres', facet.count], ['primaryGenres', facet.primaryCount], ['excludedGenres', facet.excludeCount]] as const) {
					const rules = {
						genres: selection.genres.filter(key => key !== facet.key),
						primaryGenres: selection.primaryGenres.filter(key => key !== facet.key),
						excludedGenres: selection.excludedGenres.filter(key => key !== facet.key),
					};
					rules[field].push(facet.key);
					expect(count, `${JSON.stringify(selection)}: ${facet.key} ${field}`).toBe((await browse(rules)).pagination.totalEntries);
				}
			}
		}
		expect((await repository.getSchedulingCatalogForItems(['one'])).media[0]?.primaryGenreKey).toBe('comedy');
		expect(await repository.getMediaCardPreview('one')).toMatchObject({ primaryGenre: 'comedy' });
		expect(await repository.getMediaCardPreview('unknown')).toMatchObject({ primaryGenre: null });

		const groupId = randomUUID();
		database.sqlite.prepare(`INSERT INTO media_groups (id, library_id, stable_key, kind, title, sort_title, metadata)
			VALUES (?, ?, 'group', 'show', 'Series', 'Series', '{}')`).run(groupId, library.id);
		database.sqlite.prepare("UPDATE media_items SET group_id = ? WHERE id IN ('one', 'two')").run(groupId);
		expect((await browse({ parentId: groupId, primaryGenres: ['comedy'] })).items.map(item => item.id)).toEqual(['one']);
		expect((await browse({ primaryGenres: ['comedy'] })).entries.map(entry => entry.item?.id)).toEqual(['one']);

	}
	finally {
		database.close();
	}
});
