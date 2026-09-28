import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createDatabase } from '@server/db/index.js';
import { libraries, mediaItems, mediaItemGenres } from '@server/db/schema.js';
import { MediaCatalogRepository } from '@server/repository/catalog.js';

it('loads bounded title/year/type/genre metadata in one query without plots or file paths', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const { db, sqlite } = database;
		const libraryIds = [randomUUID(), randomUUID()];
		for (const id of libraryIds) {
			db.insert(libraries).values({ id, name: id, typeKey: 'movies', sourceType: 'local', sourceConfig: { scanRoot: '/media', playbackRoot: null } }).run();
		}
		const ids: string[] = [];
		for (const [index, title] of ['Zulu', 'Alpha', 'Beta', 'Other library'].entries()) {
			const id = randomUUID();
			ids.push(id);
			db.insert(mediaItems).values({ id, libraryId: libraryIds[index === 3 ? 1 : 0]!, stableKey: id,
				kind: 'movie', title, sortTitle: title, year: index === 1 ? 2026 : null,
				relativePath: id, playbackPath: `/media/${id}`, metadataStatus: 'complete', metadata: {},
				plot: 'Do not send this plot', fingerprint: id, dateAddedAt: '2026-01-01',
			}).run();
		}
		for (const genre of ['Science Fiction', 'Action']) {
			db.insert(mediaItemGenres).values({ itemId: ids[1]!, libraryId: libraryIds[0]!, genreKey: genre.toLowerCase(), genreName: genre }).run();
		}
		const prepare = vi.spyOn(sqlite, 'prepare');
		const catalog = await new MediaCatalogRepository(db).listLibraryTitleYears(libraryIds[0]!, 2);
		expect(catalog).toEqual([
			{ id: ids[1], title: 'Alpha', year: 2026, kind: 'movie', genres: ['Action', 'Science Fiction'] },
			{ id: ids[2], title: 'Beta', year: null, kind: 'movie', genres: [] },
		]);
		expect(prepare).toHaveBeenCalledTimes(1);
	}
	finally {
		database.close();
	}
});

it('loads bounded local plot evidence with episode identities in two library-scoped queries', async () => {
	const { readAiCatalog } = await import('@server/repository/ai-catalog.js');
	const { mediaGroups } = await import('@server/db/schema.js');
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const libraryId = randomUUID();
		const showId = randomUUID();
		const seasonId = randomUUID();
		database.db.insert(libraries).values({ id: libraryId, name: 'Shows', typeKey: 'shows', sourceType: 'local', sourceConfig: { scanRoot: '/shows', playbackRoot: null } }).run();
		for (const group of [{ id: showId, kind: 'show', title: 'Series', parentId: null }, { id: seasonId, kind: 'season', title: 'Season 1', parentId: showId }]) {
			database.db.insert(mediaGroups).values({ ...group, libraryId, stableKey: group.id, sortTitle: group.title, year: 2020, metadata: {} }).run();
		}
		const id = randomUUID();
		database.db.insert(mediaItems).values({ id, libraryId, groupId: seasonId, stableKey: id, title: 'Pilot', sortTitle: 'Pilot', kind: 'episode', year: 2021,
			seasonNumber: 1, episodeNumber: 1, metadata: { tags: ['space'], rating: 8.2 }, plot: 'Private plot', relativePath: id, playbackPath: id,
			metadataStatus: 'complete', fingerprint: id, dateAddedAt: '2020-01-01' }).run();
		const prepare = vi.spyOn(database.sqlite, 'prepare');
		const result = await readAiCatalog(database.db, libraryId);
		expect(result).toEqual([{ id, title: 'Pilot', year: 2021, kind: 'episode', genres: [], rating: 8.2, plot: 'Private plot', keywords: ['space'], series: 'Series', seriesYear: 2020, season: 1, episode: 1 }]);
		expect(prepare).toHaveBeenCalledTimes(2);
	}
	finally {
		database.close();
	}
});
