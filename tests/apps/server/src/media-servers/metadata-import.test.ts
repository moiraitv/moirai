import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogProgramItemQuerySchema, libraryCreateSchema, programCreateSchema, TOP_BILLED_ACTOR_COUNT } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { buildRemoteCatalog } from '@server/media-servers/catalog.js';
import { JellyfinClient } from '@server/media-servers/jellyfin-client.js';
import { PlexClient } from '@server/media-servers/plex-client.js';
import { schedulingProgramStatuses } from '@server/scheduling/status.js';

/** Provider responses retain a fixed update marker while individual catalog facts change. */
function providerRow(provider: 'plex' | 'jellyfin' | 'emby') {
	const cast = [
		...Array.from({ length: TOP_BILLED_ACTOR_COUNT - 1 }, (_, index) => ({ name: `Cast ${index}`, role: 'Supporting' })),
		{ name: 'Cast 0', role: 'Duplicate credit' },
		{ name: 'Harrison Ford', role: 'Han Solo' },
		{ name: 'Outside Actor', role: 'Cameo' },
	];
	if (provider === 'plex') {
		return {
			ratingKey: 'movie', title: 'Example', titleSort: 'Sort Example', summary: 'A movie.', year: 2020,
			updatedAt: 1_700_000_000, originallyAvailableAt: '2020-05-04', originalTitle: 'Original title',
			audienceRating: 8, rating: 6, userRating: 0, contentRating: 'PG-13', editionTitle: 'Extended',
			studio: 'Example Studio', Country: [{ tag: 'Canada' }], Label: [{ tag: 'Space' }],
			Writer: [{ tag: 'Example Writer' }], Genre: [{ tag: 'Adventure' }],
			Director: [{ tag: 'Example Director' }], Role: cast.map(({ name, role }) => ({ tag: name, role })),
			Media: [{ duration: 120_000, Part: [{ id: 1, file: '/movies/example.mkv', duration: 120_000 }] }],
		};
	}
	return {
		Id: 'movie', Name: 'Example', SortName: 'Sort Example', Overview: 'A movie.', ProductionYear: 2020,
		DateLastSaved: '2026-01-01T00:00:00.000Z', PremiereDate: '2020-05-04T00:00:00Z', OriginalTitle: 'Original title',
		CommunityRating: 8, UserData: { Rating: 0 }, OfficialRating: 'PG-13', Studios: [{ Name: 'Example Studio' }],
		ProductionLocations: ['Canada'], Tags: ['Space'], Genres: ['Adventure'],
		People: [{ Type: 'Director', Name: 'Example Director' }, { Type: 'Writer', Name: 'Example Writer' },
			...cast.map(({ name, role }) => ({ Type: 'Actor', Name: name, Role: role }))],
		Path: '/movies/example.mkv', RunTimeTicks: 1_200_000_000,
		MediaSources: [{ Id: 'source' }],
		MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 },
			{ Index: 1, Type: 'Subtitle', Codec: 'subrip', Language: 'eng', IsForced: true }],
	};
}

for (const provider of ['plex', 'jellyfin', 'emby'] as const) {
	describe(`${provider} complete metadata import`, () => {
		it('repairs prior imports and shares credits and facts across browsing, saved Programs, and display', async () => {
			const database = createDatabase(':memory:', path.resolve('drizzle'));
			try {
				const repository = new Repository(database.db);
				const server = await repository.mediaServers.createMediaServer({
					provider, name: 'Test', baseUrl: 'https://media.example', accessToken: 'synthetic-token',
					allowInsecureTls: false, playbackReportingEnabled: false, pathReplacements: [],
				}, { serverKey: 'test', serverName: 'Test', libraries: [] });
				const library = await repository.createLibrary(libraryCreateSchema.parse({
					name: 'Movies', typeKey: 'movies', sourceType: provider, watcherEnabled: false,
					sourceConfig: { mediaServerId: server.id, remoteLibraryId: 'movies', remoteLibraryName: 'Movies' },
				}));
				const identity = { sourceType: provider, sourceKey: `${provider}:test:movies`, details: {} };
				let row: Record<string, unknown> = providerRow(provider);
				const requests: string[] = [];
				const fetch = async (url: string) => {
					requests.push(url);
					return {
						ok: true, status: 200, headers: { get: () => null }, body: null,
						arrayBuffer: async () => new ArrayBuffer(0),
						text: async () => JSON.stringify(provider === 'plex'
							? { MediaContainer: { totalSize: 1, Metadata: [row] } }
							: { TotalRecordCount: 1, Items: [row] }),
					};
				};
				const connection = { provider, baseUrl: 'https://media.example', accessToken: 'synthetic-token', clientIdentifier: 'test-client', allowInsecureTls: false };
				const client = provider === 'plex' ? new PlexClient(fetch, connection) : new JellyfinClient(fetch, connection);
				async function discovery() {
					const priorRequests = requests.length;
					const items = await client.listItems('movies', 'movies');
					expect(requests.length - priorRequests).toBe(1);
					return buildRemoteCatalog({ libraryId: library.id, mediaServerId: server.id, replacements: [], items });
				}
				async function rescan() {
					const catalog = await discovery();
					return repository.reconcileScan(await repository.beginScan(library.id, 'manual'), catalog.groups, catalog.items, [], true, identity);
				}

				// Reproduce the previous importer: searchable people exist but metadata has no credits.
				const prior = await discovery();
				const priorItem = prior.items[0]!;
				const legacy = { ...priorItem, fingerprint: 'remote-metadata-v1', metadata: {
					genres: priorItem.metadata.genres, artists: [], album: null,
				} };
				await repository.reconcileScan(await repository.beginScan(library.id, 'initial'), [], [legacy], [], true, identity);
				const program = await repository.createProgram(programCreateSchema.parse({ name: 'Actor showcase', config: {
					type: 'content', source: { type: 'library-query', libraryId: library.id, actor: 'harrison ford', actorTopBilledOnly: true },
					strategy: { type: 'sequential' },
				} }));
				expect(schedulingProgramStatuses([program], await repository.getSchedulingCatalog([program]))[0]?.indexedItemCount).toBe(0);
				expect((await rescan()).changedCount).toBe(1);
				expect((await rescan()).changedCount).toBe(0);

				// The saved query and SQL catalog agree, even though the raw billing value exceeds ten.
				const catalog = await repository.getSchedulingCatalog([program]);
				expect(schedulingProgramStatuses([program], catalog)[0]).toMatchObject({ health: 'ready', indexedItemCount: 1, availableItemCount: 1 });
				const query = catalogProgramItemQuerySchema.parse({ actor: 'HARRISON FORD', actorTopBilledOnly: true,
					director: 'example director', minimumRating: 7.5, minimumUserRating: 0 });
				expect((await repository.browseMedia(library.id, { ...query, page: 1, pageSize: 100 })).items).toHaveLength(1);
				const outside = { ...query, actor: 'Outside Actor' };
				expect((await repository.browseMedia(library.id, { ...outside, page: 1, pageSize: 100 })).items).toHaveLength(0);
				const media = catalog.media[0]!;
				expect(media).toMatchObject({ sortTitle: 'Sort Example', releaseDate: '2020-05-04', rating: 8, userRating: 0,
					directors: ['Example Director'], tags: ['Space'], displayMetadata: {
						originalTitle: 'Original title', certification: 'PG-13', writers: ['Example Writer'], studios: ['Example Studio'], countries: ['Canada'],
					} });
				expect(media.displayMetadata?.cast).toContainEqual({ name: 'Harrison Ford', role: 'Han Solo' });
				const detail = await repository.getMediaItem(media.id);
				expect(detail).toMatchObject({ rating: 8, writers: ['Example Writer'], studios: ['Example Studio'], countries: ['Canada'], certification: 'PG-13' });
				if (provider === 'plex') {
					expect(detail?.edition).toBe('Extended');
				}
				else {
					expect(detail?.resolution).toEqual({ width: 1920, height: 1080 });
					expect(detail?.subtitleTracks).toEqual(expect.arrayContaining([expect.objectContaining({ language: 'eng', isForced: true })]));
					const fields = new URL(requests[0]!).searchParams.get('Fields')!.split(',');
					expect(fields).toEqual(expect.arrayContaining(['SortName', 'DateLastSaved', 'OriginalTitle', 'Studios', 'ProductionLocations', 'Tags']));
					const remote = (await client.listItems('movies', 'movies'))[0]!;
					expect(remote.parts[0]?.filePath).toBe('/movies/example.mkv');
				}

				// Unchanged provider timestamps must not hide edits to otherwise omitted facts.
				const updates = provider === 'plex' ? [
					{ audienceRating: 9 }, { userRating: 7 }, { originallyAvailableAt: '2020-06-01' },
					{ titleSort: 'New Sort' }, { originalTitle: 'New Original' }, { contentRating: 'R' },
					{ studio: 'New Studio' }, { Writer: [{ tag: 'New Writer' }] }, { Country: [{ tag: 'France' }] },
					{ Label: [{ tag: 'New Tag' }] }, { editionTitle: 'Theatrical' },
					{ Media: [{ duration: 180_000, Part: [{ id: 1, file: '/movies/example.mkv', duration: 180_000 }] }] },
				] : [
					{ CommunityRating: 9 }, { UserData: { Rating: 7 } }, { PremiereDate: '2020-06-01T00:00:00Z' },
					{ SortName: 'New Sort' }, { OriginalTitle: 'New Original' }, { OfficialRating: 'R' },
					{ Studios: [{ Name: 'New Studio' }] }, { People: [{ Type: 'Writer', Name: 'New Writer' }, { Type: 'Actor', Name: 'Harrison Ford', Role: 'Han Solo' }] },
					{ ProductionLocations: ['France'] }, { Tags: ['New Tag'] }, { RunTimeTicks: 1_800_000_000 },
					{ ImageTags: { Primary: 'new-image-version' } },
				];
				for (const update of updates) {
					row = { ...row, ...update };
					expect((await rescan()).changedCount, Object.keys(update).join(',')).toBe(1);
					expect((await rescan()).changedCount).toBe(0);
				}

				// Missing and invalid upstream values clear old catalog facts instead of preserving them.
				row = provider === 'plex' ? { ...row, Role: [], Director: [], Writer: [], Country: [], Label: [], studio: '',
					audienceRating: -1, userRating: 100, originallyAvailableAt: '2020-02-31' }
					: { ...row, People: [], Studios: [], ProductionLocations: [], Tags: [], CommunityRating: -1, UserData: { Rating: 100 }, PremiereDate: '2020-02-31' };
				expect((await rescan()).changedCount).toBe(1);
				const cleared = (await repository.getSchedulingCatalog([program])).media[0]!;
				expect(cleared).toMatchObject({ actors: [], directors: [], tags: [], releaseDate: null, rating: null, userRating: null,
					displayMetadata: { cast: [], studios: [], countries: [], writers: [] } });
				expect(schedulingProgramStatuses([program], await repository.getSchedulingCatalog([program]))[0]?.indexedItemCount).toBe(0);
			}
			finally {
				database.close();
			}
		});
	});
}
