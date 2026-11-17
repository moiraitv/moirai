import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { libraryCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { mediaItemGenres, mediaItemPeople } from '@server/db/schema.js';
import { Repository } from '@server/repository/index.js';
import { buildRemoteCatalog } from '@server/media-servers/catalog.js';
import { JellyfinClient } from '@server/media-servers/jellyfin-client.js';

for (const provider of ['jellyfin', 'emby'] as const) {
	describe(`${provider} catalog metadata`, () => {
		it.each([undefined, '2026-08-23T00:00:00.000Z'])('refreshes normalized metadata with an unchanged fallback etag (%s)', async (createdAt) => {
			const database = createDatabase(':memory:', path.resolve('drizzle'));
			try {
				const repository = new Repository(database.db);
				const server = await repository.mediaServers.createMediaServer({
					provider, name: 'Test server', baseUrl: 'https://media.example',
					accessToken: 'synthetic-token', allowInsecureTls: false, playbackReportingEnabled: false, pathReplacements: [],
				}, { serverKey: 'test-server', serverName: 'Test server', libraries: [] });
				const library = await repository.createLibrary(libraryCreateSchema.parse({
					name: 'Movies', typeKey: 'movies', sourceType: provider, watcherEnabled: false,
					sourceConfig: { mediaServerId: server.id, remoteLibraryId: 'movies', remoteLibraryName: 'Movies' },
				}));
				let genre = 'Drama';
				let actor = 'Original Actor';
				let director = 'Original Director';
				const client = new JellyfinClient(async () => ({
					ok: true, status: 200, headers: { get: () => null }, body: null,
					arrayBuffer: async () => new ArrayBuffer(0),
					text: async () => JSON.stringify({ TotalRecordCount: 1, Items: [{
						Id: 'movie', Name: 'Movie', DateCreated: createdAt,
						MediaSources: [{ Id: 'source', Path: '/movies/movie.mkv' }],
						Genres: genre ? [genre] : [],
						People: [
							...(actor ? [{ Type: 'Actor', Name: actor, Role: 'Lead' }] : []),
							...(director ? [{ Type: 'Director', Name: director }] : []),
						],
					}] }),
				}), { provider, baseUrl: 'https://media.example', accessToken: 'synthetic-token', clientIdentifier: 'test-client', allowInsecureTls: false });
				async function rescan() {
					const remote = await client.listItems('movies', 'movies');
					expect(remote[0]?.etag).toBe(createdAt ?? 'movie');
					const catalog = await buildRemoteCatalog({ libraryId: library.id, mediaServerId: server.id, replacements: [], items: remote });
					const run = await repository.beginScan(library.id, 'manual');
					return repository.reconcileScan(run, catalog.groups, catalog.items, catalog.issues, true, {
						sourceType: provider, sourceKey: `${provider}:test-server:movies`, details: {},
					});
				}

				expect((await rescan()).changedCount).toBe(1);
				expect((await rescan()).changedCount).toBe(0);
				genre = 'Comedy';
				expect((await rescan()).changedCount).toBe(1);
				expect(await database.db.select({ key: mediaItemGenres.genreKey }).from(mediaItemGenres)).toEqual([{ key: 'comedy' }]);
				actor = 'Updated Actor';
				expect((await rescan()).changedCount).toBe(1);
				director = 'Updated Director';
				expect((await rescan()).changedCount).toBe(1);
				expect(await database.db.select({ type: mediaItemPeople.personType, name: mediaItemPeople.name }).from(mediaItemPeople)).toEqual(expect.arrayContaining([
					{ type: 'actor', name: actor }, { type: 'director', name: director },
				]));
				expect(await database.db.select().from(mediaItemPeople)).toHaveLength(2);
				expect((await rescan()).changedCount).toBe(0);
				genre = '';
				actor = '';
				director = '';
				expect((await rescan()).changedCount).toBe(1);
				expect(await database.db.select().from(mediaItemGenres)).toEqual([]);
				expect(await database.db.select().from(mediaItemPeople)).toEqual([]);
			}
			finally {
				database.close();
			}
		});
	});
}
