import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { libraryCreateSchema, mediaServerUpdateSchema, type Library } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { ScannerManager } from '@server/scanner/manager.js';
import { LibrarySourceRegistry } from '@server/scanner/source-registry.js';
import type { MediaProbe } from '@server/media/media-probe.js';
import type { MediaFetch, MediaFetchResponse } from '@server/media-servers/http.js';
import { JellyfinClient } from '@server/media-servers/jellyfin-client.js';
import { PlexClient } from '@server/media-servers/plex-client.js';
import { buildRemoteCatalog } from '@server/media-servers/catalog.js';
import { localPathForRemote } from '@server/media-servers/paths.js';
import { MediaServerSourceAdapter } from '@server/scanner/media-server-adapter.js';
import type { MediaServerConnectionRecord } from '@server/repository/media-servers.js';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const LIBRARY_ID = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** JSON response the scripted provider client can read. */
function jsonResponse(status: number, body: unknown): MediaFetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => null },
		text: async () => JSON.stringify(body),
		arrayBuffer: async () => new ArrayBuffer(0),
		body: null,
	};
}

/** Route scripted Plex responses and fail when a caller asks for an unknown URL. */
function plexFetch(handlers: Array<(url: string) => MediaFetchResponse | null>): MediaFetch {
	return async (url) => {
		for (const handler of handlers) {
			const response = handler(url);
			if (response) {
				return response;
			}
		}

		throw new Error(`Unexpected Plex request ${url}`);
	};
}

/** Saved Plex connection used by the adapter. The token must stay out of catalog output. */
function connection(replacements: MediaServerConnectionRecord['pathReplacements'] = []): MediaServerConnectionRecord {
	return {
		id: SERVER_ID,
		provider: 'plex',
		name: 'Living room',
		baseUrl: 'http://plex.test',
		serverKey: 'machine-1',
		serverName: 'Plex',
		clientIdentifier: 'moirai-client',
		accessToken: 'secret-token',
		allowInsecureTls: false,
		playbackReportingEnabled: false,
		pathReplacements: replacements,
	};
}

/** Library row the scanner would pass to the Plex adapter. */
function library(typeKey = 'movies'): Library {
	return {
		...libraryCreateSchema.parse({
			name: 'Films',
			typeKey,
			sourceType: 'plex',
			sourceConfig: {
				mediaServerId: SERVER_ID,
				remoteLibraryId: '1',
				remoteLibraryName: 'Movies',
			},
			watcherEnabled: false,
		}),
		id: LIBRARY_ID,
		watcherStatus: 'stopped',
		sourceAvailability: 'unknown',
		sourceAvailabilityUpdatedAt: null,
		reconciliationStatus: 'idle',
		pendingRemovalCount: 0,
		lastScanStartedAt: null,
		lastScanCompletedAt: null,
		lastChangeDetectedAt: null,
		lastIndexedChangeAt: null,
		itemCount: 0,
		warningCount: 0,
		createdAt: '2026-08-23T00:00:00.000Z',
		updatedAt: '2026-08-23T00:00:00.000Z',
	};
}

/** One Plex movie with an external id, a chapter, and a file path. */
function moviePage() {
	return jsonResponse(200, {
		MediaContainer: {
			totalSize: 1,
			Metadata: [{
				ratingKey: '42',
				title: 'Arrival',
				titleSort: 'Arrival',
				summary: 'A linguist meets visitors.',
				year: 2016,
				updatedAt: 1_700_000_000,
				Guid: [{ id: 'imdb://tt2543164' }],
				Genre: [{ tag: 'Drama' }],
				Role: [{ tag: 'Amy Adams', role: 'Louise' }],
				Director: [{ tag: 'Denis Villeneuve' }],
				thumb: '/library/metadata/42/thumb/1',
				Chapter: [{ startTimeOffset: 0, endTimeOffset: 60_000, tag: 'Opening' }],
				Media: [{
					duration: 120_000,
					Part: [{
						id: 7,
						file: '/data/movies/Arrival.mkv',
						size: 10,
						Stream: [{ streamType: 1, codec: 'hevc', index: 0, width: 1920, height: 1080 }],
					}],
				}],
			}],
		},
	});
}

describe('media server discovery', () => {
	it('indexes a Plex movie and keeps the same fingerprint when the etag is unchanged', async () => {
		const fetch = plexFetch([
			(url) => url.includes('/library/sections/1/all') ? moviePage() : null,
		]);
		const adapter = new MediaServerSourceAdapter('plex', {
			getMediaServerConnection: async () => connection(),
		}, undefined, () => fetch);
		const first = await adapter.discover(library(), {
			signal: new AbortController().signal,
			probeCache: new Map(),
			onProgress: () => undefined,
		});
		const second = await adapter.discover(library(), {
			signal: new AbortController().signal,
			probeCache: new Map(),
			onProgress: () => undefined,
		});
		expect(first.traversalComplete).toBe(true);
		expect(first.items).toHaveLength(1);
		expect(first.items[0]).toMatchObject({
			title: 'Arrival',
			stableKey: '42',
			year: 2016,
			playbackPath: `moirai-remote:${SERVER_ID}/7`,
		});
		expect(first.items[0]?.externalIds).toEqual([{ provider: 'imdb', value: 'tt2543164', isDefault: true }]);
		expect(first.items[0]?.groupId).toBeNull();
		expect(first.groups).toEqual([]);
		const chapters = first.items[0]?.technicalMetadata.chapters as Array<{ title: string }> | undefined;
		expect(chapters?.[0]?.title).toBe('Opening');
		expect(JSON.stringify(first)).not.toContain('secret-token');
		expect(first.items[0]?.fingerprint).toBe(second.items[0]?.fingerprint);
		expect(first.sourceIdentity.sourceKey).toBe('plex:machine-1:1');
	});

	it('indexes a Plex episode under its show and season', async () => {
		const fetch = plexFetch([
			(url) => url.includes('/library/sections/2/all') ? jsonResponse(200, {
				MediaContainer: {
					totalSize: 1,
					Metadata: [{
						ratingKey: '90',
						title: 'Pilot',
						grandparentRatingKey: '8',
						grandparentTitle: 'Example',
						parentIndex: 1,
						index: 1,
						updatedAt: 10,
						Media: [{ Part: [{ id: 3, file: '/shows/Example/Pilot.mkv' }] }],
					}],
				},
			}) : null,
		]);
		const adapter = new MediaServerSourceAdapter('plex', {
			getMediaServerConnection: async () => connection(),
		}, undefined, () => fetch);
		const showLibrary = library('shows');
		showLibrary.sourceConfig = {
			mediaServerId: SERVER_ID,
			remoteLibraryId: '2',
			remoteLibraryName: 'TV',
		};
		const discovered = await adapter.discover(showLibrary, {
			signal: new AbortController().signal,
			probeCache: new Map(),
			onProgress: () => undefined,
		});
		expect(discovered.groups.map((group) => group.title).sort()).toEqual(['Example', 'Season 1']);
		expect(discovered.items[0]?.kind).toBe('episode');
		expect(discovered.items[0]?.groupId).toBeTruthy();
	});

	it('fails the scan when Plex returns an error instead of a partial catalog', async () => {
		const fetch = plexFetch([
			(url) => url.includes('/library/sections/') ? jsonResponse(500, { error: 'secret-token' }) : null,
		]);
		const adapter = new MediaServerSourceAdapter('plex', {
			getMediaServerConnection: async () => connection(),
		}, undefined, () => fetch);
		await expect(adapter.discover(library(), {
			signal: new AbortController().signal,
			probeCache: new Map(),
			onProgress: () => undefined,
		})).rejects.toThrow(/HTTP 500/);
	});

	it('reports present, absent, and inconclusive items without starting from a thrown network error', async () => {
		const fetch: MediaFetch = async (url) => {
			if (url.endsWith('/library/metadata/present')) {
				return jsonResponse(200, {});
			}

			if (url.endsWith('/library/metadata/missing')) {
				return jsonResponse(404, {});
			}

			throw new Error('socket hang up');
		};
		const adapter = new MediaServerSourceAdapter('plex', {
			getMediaServerConnection: async () => connection(),
		}, undefined, () => fetch);
		const checked = await adapter.checkPresence(library(), [
			{ itemId: 'a', stableKey: 'present', relativePaths: [] },
			{ itemId: 'b', stableKey: 'missing', relativePaths: [] },
			{ itemId: 'c', stableKey: 'offline', relativePaths: [] },
		], { signal: new AbortController().signal });
		expect(checked.observations).toEqual([
			{ itemId: 'a', status: 'present' },
			{ itemId: 'b', status: 'absent' },
			{ itemId: 'c', status: 'inconclusive' },
		]);
		expect(checked.sourceIdentity.sourceKey).toBe('plex:machine-1:1');
	});

	it('uses a mapped local file and otherwise keeps the remote playback reference', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-remote-'));
		roots.push(root);
		const file = path.join(root, 'Arrival.mkv');
		await writeFile(file, 'video');
		const catalog = await buildRemoteCatalog({
			libraryId: LIBRARY_ID,
			mediaServerId: SERVER_ID,
			replacements: [{ remotePrefix: '/data/movies', localPrefix: root }],
			items: [{
				id: '42',
				etag: '1',
				kind: 'movie',
				title: 'Arrival',
				sortTitle: null,
				plot: null,
				year: 2016,
				show: null,
				seasonNumber: null,
				seasonTitle: null,
				episodeNumber: null,
				artists: [],
				album: null,
				albumId: null,
				trackNumber: null,
				genres: [],
				directors: [],
				actors: [],
				externalIds: [],
				parts: [{
					id: '7',
					filePath: '/data/movies/Arrival.mkv',
					durationMilliseconds: 1_000,
					sizeBytes: 5,
					container: 'mkv',
					streams: [],
					chapters: [],
				}, {
					id: '8',
					filePath: '/other/Missing.mkv',
					durationMilliseconds: 1_000,
					sizeBytes: 5,
					container: 'mkv',
					streams: [],
					chapters: [],
				}],
				posterPath: null,
				landscapePath: null,
				fanartPath: null,
				modifiedAt: '2026-08-23T00:00:00.000Z',
			}],
		});
		expect(catalog.items[0]?.playbackPath).toBe(file);
		expect(catalog.items[0]?.relativePath).toBe('42');
		expect(catalog.items[0]?.parts?.[1]?.playbackPath).toBe(`moirai-remote:${SERVER_ID}/8`);
		expect(localPathForRemote([{ remotePrefix: '/media', localPrefix: '/local' }], '/media2/nope')).toBeNull();
		expect(localPathForRemote(
			[{ remotePrefix: '/data/media', localPrefix: root }],
			'/data/media/../../secrets/file.mkv',
		)).toBeNull();
		await symlink('/etc/passwd', path.join(root, 'escape'));
		expect(localPathForRemote(
			[{ remotePrefix: '/data/movies', localPrefix: root }],
			'/data/movies/escape',
		)).toBeNull();
	});

	it('offers Plex personal-media libraries as other videos and Jellyfin music-video libraries', async () => {
		const plex = new PlexClient(plexFetch([
			(url) => url.endsWith('/identity') ? jsonResponse(200, { MediaContainer: { machineIdentifier: 'machine-1', friendlyName: 'Plex' } }) : null,
			(url) => url.endsWith('/library/sections') ? jsonResponse(200, {
				MediaContainer: {
					Directory: [
						{ key: '1', title: 'Movies', type: 'movie', agent: 'tv.plex.agents.movie' },
						{ key: '2', title: 'Home videos', type: 'movie', agent: 'tv.plex.agents.none' },
						{ key: '3', title: 'Shows', type: 'show' },
					],
				},
			}) : null,
		]), {
			provider: 'plex',
			baseUrl: 'http://plex.test',
			accessToken: 'secret-token',
			clientIdentifier: 'moirai-client',
			allowInsecureTls: false,
		});
		expect((await plex.inspect()).libraries).toEqual([
			{ id: '1', name: 'Movies', typeKey: 'movies' },
			{ id: '2', name: 'Home videos', typeKey: 'other' },
			{ id: '3', name: 'Shows', typeKey: 'shows' },
		]);
		expect(await plex.listItems('1', 'music-videos')).toEqual([]);

		const jellyfin = new JellyfinClient(async (url) => {
			if (url.endsWith('/System/Info')) {
				return jsonResponse(200, { Id: 'jf-1', ServerName: 'Jellyfin' });
			}

			return jsonResponse(200, {
				Items: [{ Id: 'mv', Name: 'Music Videos', CollectionType: 'musicvideos' }],
			});
		}, {
			provider: 'jellyfin',
			baseUrl: 'http://jellyfin.test',
			accessToken: 'secret-token',
			clientIdentifier: 'moirai-client',
			allowInsecureTls: false,
		});
		expect((await jellyfin.inspect()).libraries).toEqual([
			{ id: 'mv', name: 'Music Videos', typeKey: 'music-videos' },
		]);
	});

	it.each(['account', 'api-key'] as const)('discovers Jellyfin libraries with %s credentials without administrator access', async (credential) => {
		const requested: string[] = [];
		const fetch: MediaFetch = async (url, init) => {
			const request = new URL(url);
			requested.push(request.pathname);
			if (request.pathname === '/Users/AuthenticateByName') {
				return jsonResponse(200, { AccessToken: 'synthetic-account-token' });
			}
			if (request.pathname === '/Library/MediaFolders') {
				return jsonResponse(403, {});
			}
			expect(init?.headers?.Authorization).toContain(credential === 'account' ? 'synthetic-account-token' : 'synthetic-api-key');
			if (request.pathname === '/System/Info') {
				return jsonResponse(200, { Id: 'jf-1', ServerName: 'Jellyfin' });
			}
			expect(request.pathname).toBe('/Items');
			expect(request.searchParams.get('Recursive')).toBe('false');
			expect(request.searchParams.get('IncludeItemTypes')).toBe('CollectionFolder');
			return jsonResponse(200, { Items: [{ Id: 'allowed-movies', Name: 'Movies', CollectionType: 'movies' }] });
		};
		const connection = { provider: 'jellyfin' as const, baseUrl: 'http://jellyfin.test', clientIdentifier: 'moirai-client', allowInsecureTls: false };
		const accessToken = credential === 'account'
			? await JellyfinClient.signIn(fetch, connection, 'viewer', 'synthetic-password')
			: 'synthetic-api-key';
		const client = new JellyfinClient(fetch, { ...connection, accessToken });
		expect((await client.inspect()).libraries).toEqual([{ id: 'allowed-movies', name: 'Movies', typeKey: 'movies' }]);
		expect(requested).not.toContain('/Library/MediaFolders');
	});

	it('accepts a remote library create payload without a credential field', () => {
		const parsed = libraryCreateSchema.parse({
			name: 'Films',
			typeKey: 'movies',
			sourceType: 'jellyfin',
			sourceConfig: {
				mediaServerId: SERVER_ID,
				remoteLibraryId: 'library',
				remoteLibraryName: 'Movies',
			},
		});
		expect(parsed.sourceConfig).toEqual({
			mediaServerId: SERVER_ID,
			remoteLibraryId: 'library',
			remoteLibraryName: 'Movies',
		});
		expect(JSON.stringify(parsed)).not.toContain('accessToken');
	});

	it('keeps the same catalog id when the provider file path changes', async () => {
		const item = {
			id: '42',
			etag: '1',
			kind: 'movie' as const,
			title: 'Arrival',
			sortTitle: null,
			plot: null,
			year: 2016,
			show: null,
			seasonNumber: null,
			seasonTitle: null,
			episodeNumber: null,
			artists: [],
			album: null,
			albumId: null,
			trackNumber: null,
			genres: [],
			directors: [],
			actors: [],
			externalIds: [],
			posterPath: null,
			landscapePath: null,
			fanartPath: null,
			modifiedAt: '2026-08-23T00:00:00.000Z',
		};
		const first = await buildRemoteCatalog({
			libraryId: LIBRARY_ID,
			mediaServerId: SERVER_ID,
			replacements: [],
			items: [{ ...item, parts: [{ id: '7', filePath: '/data/a.mkv', durationMilliseconds: 1_000, sizeBytes: 1, container: 'mkv', streams: [], chapters: [] }] }],
		});
		const second = await buildRemoteCatalog({
			libraryId: LIBRARY_ID,
			mediaServerId: SERVER_ID,
			replacements: [],
			items: [{ ...item, parts: [{ id: '7', filePath: '/data/b.mkv', durationMilliseconds: 1_000, sizeBytes: 1, container: 'mkv', streams: [], chapters: [] }] }],
		});
		expect(first.items[0]?.relativePath).toBe('42');
		expect(second.items[0]?.relativePath).toBe('42');
		expect(first.items[0]?.id).toBe(second.items[0]?.id);
		expect(second.items[0]?.parts[0]?.relativePath).toBe('/data/b.mkv');
	});

	it('groups remote music videos and leaves movies ungrouped', async () => {
		const part = {
			id: '7',
			filePath: '/data/a.mkv',
			durationMilliseconds: 1_000,
			sizeBytes: 1,
			container: 'mkv',
			streams: [],
			chapters: [],
		};
		const shared = {
			etag: '1',
			sortTitle: null,
			plot: null,
			year: null,
			show: null,
			seasonNumber: null,
			seasonTitle: null,
			episodeNumber: null,
			albumId: null,
			trackNumber: null,
			genres: [],
			directors: [],
			actors: [],
			externalIds: [],
			posterPath: null,
			landscapePath: null,
			fanartPath: null,
			modifiedAt: '2026-08-23T00:00:00.000Z',
		};
		const catalog = await buildRemoteCatalog({
			libraryId: LIBRARY_ID,
			mediaServerId: SERVER_ID,
			replacements: [],
			items: [{
				...shared,
				id: '42',
				kind: 'movie',
				title: 'Arrival',
				artists: [],
				album: null,
				parts: [part],
			}, {
				...shared,
				id: 'mv',
				kind: 'music-video',
				title: 'Track',
				artists: ['Artist'],
				album: 'Album',
				parts: [{ ...part, id: '9' }],
			}],
		});
		expect(catalog.items.find((item) => item.kind === 'movie')?.groupId).toBeNull();
		const video = catalog.items.find((item) => item.kind === 'music-video');
		const album = catalog.groups.find((group) => group.kind === 'album');
		expect(catalog.groups.map((group) => group.title).sort()).toEqual(['Album', 'Artist']);
		expect(video?.groupId).toBe(album?.id);
	});

	it('does not treat one full page without a total as the whole library', async () => {
		const page = Array.from({ length: 200 }, (_, index) => ({
			ratingKey: String(index + 1),
			title: 'Film',
			Media: [{ Part: [{ id: index + 1, file: `/movies/${index}.mkv` }] }],
		}));
		const plex = new PlexClient(plexFetch([
			(url) => url.includes('/library/sections/1/all') ? jsonResponse(200, { MediaContainer: { Metadata: page } }) : null,
		]), {
			provider: 'plex',
			baseUrl: 'http://plex.test',
			accessToken: 'secret-token',
			clientIdentifier: 'moirai-client',
			allowInsecureTls: false,
		});
		await expect(plex.listItems('1', 'movies')).rejects.toThrow(/how many items/);
	});

	it('does not treat an empty or short total as a finished Plex or Jellyfin library', async () => {
		const plex = new PlexClient(plexFetch([
			() => jsonResponse(200, { MediaContainer: { totalSize: 5, Metadata: [] } }),
		]), {
			provider: 'plex',
			baseUrl: 'http://plex.test',
			accessToken: 'secret-token',
			clientIdentifier: 'moirai-client',
			allowInsecureTls: false,
		});
		await expect(plex.listItems('1', 'movies')).rejects.toThrow(/before reporting every item/);

		const shortTotal = new PlexClient(plexFetch([
			() => jsonResponse(200, {
				MediaContainer: {
					totalSize: 0,
					Metadata: [{ ratingKey: '1', title: 'Film', Media: [{ Part: [{ id: 1, file: '/a.mkv' }] }] }],
				},
			}),
		]), {
			provider: 'plex',
			baseUrl: 'http://plex.test',
			accessToken: 'secret-token',
			clientIdentifier: 'moirai-client',
			allowInsecureTls: false,
		});
		await expect(shortTotal.listItems('1', 'movies')).rejects.toThrow(/fewer items/);

		const empty = new PlexClient(plexFetch([
			() => jsonResponse(200, { MediaContainer: { totalSize: 0, Metadata: [] } }),
		]), {
			provider: 'plex',
			baseUrl: 'http://plex.test',
			accessToken: 'secret-token',
			clientIdentifier: 'moirai-client',
			allowInsecureTls: false,
		});
		expect(await empty.listItems('1', 'movies')).toEqual([]);
		const emptyWithoutMetadata = new PlexClient(async () => jsonResponse(200, { MediaContainer: { size: 0 } }), connection());
		expect(await emptyWithoutMetadata.listItems('1', 'movies')).toEqual([]);

		const jellyfin = new JellyfinClient(async () => jsonResponse(200, {
			Items: [],
			TotalRecordCount: 4,
		}), {
			provider: 'jellyfin',
			baseUrl: 'http://jellyfin.test',
			accessToken: 'secret-token',
			clientIdentifier: 'moirai-client',
			allowInsecureTls: false,
		});
		await expect(jellyfin.listItems('library', 'movies')).rejects.toThrow(/before reporting every item/);
	});

	it('keeps the largest Plex version and drops sidecar subtitles', async () => {
		const plex = new PlexClient(plexFetch([
			() => jsonResponse(200, {
				MediaContainer: {
					totalSize: 1,
					Metadata: [{
						ratingKey: '9',
						title: 'Film',
						Media: [{
							width: 1280,
							height: 720,
							bitrate: 4_000,
							Part: [{ id: 1, file: '/720.mkv', duration: 90_000 }],
						}, {
							width: 1920,
							height: 1080,
							bitrate: 1_000,
							Part: [{ id: 4, file: '/1080-small.mkv' }],
						}, {
							width: 1920,
							height: 1080,
							bitrate: 12_000,
							Part: [{
								id: 2,
								file: '/1080-a.mkv',
								duration: 40_000,
								Stream: [
									{ streamType: 1, index: 0, codec: 'hevc' },
									{ streamType: 3, index: 2, codec: 'subrip', default: true },
									{ streamType: 3, index: 0, codec: 'srt', key: '/library/streams/9', selected: true },
								],
							}, {
								id: 3,
								file: '/1080-b.mkv',
							}],
						}],
					}],
				},
			}),
		]), {
			provider: 'plex',
			baseUrl: 'http://plex.test',
			accessToken: 'secret-token',
			clientIdentifier: 'moirai-client',
			allowInsecureTls: false,
		});
		const [item] = await plex.listItems('1', 'movies');
		expect(item?.parts.map((part) => part.id)).toEqual(['2', '3']);
		expect(item?.parts.map((part) => part.durationMilliseconds)).toEqual([40_000, null]);
		expect(item?.parts[0]?.streams).toEqual([
			expect.objectContaining({ index: 0, type: 'video' }),
			expect.objectContaining({ index: 2, type: 'subtitle', isDefault: true }),
		]);
	});

	it('chooses a complete Plex version when higher-quality versions have invalid part IDs', async () => {
		const plex = new PlexClient(async () => jsonResponse(200, {
			MediaContainer: {
				totalSize: 1,
				Metadata: [{ ratingKey: '9', title: 'Film', Media: [
					{ width: 3840, height: 2160, Part: [{ id: 11 }, { file: '/unnamed-part.mkv' }] },
					{ width: 2560, height: 1440, Part: [{ id: 12 }, { id: '012' }] },
					{ width: 1920, height: 1080, Part: [{ id: 13 }, { id: null }] },
					{ width: 1280, height: 720, Part: [{ id: 14, duration: 40_000 }, { id: '15', duration: 50_000 }] },
				] }],
			},
		}), connection());
		const [item] = await plex.listItems('1', 'movies');
		expect(item?.parts).toEqual([
			expect.objectContaining({ id: '14', durationMilliseconds: 40_000 }),
			expect.objectContaining({ id: '15', durationMilliseconds: 50_000 }),
		]);
	});

	it('uses a media duration only for a single Plex part', async () => {
		const plex = new PlexClient(plexFetch([
			() => jsonResponse(200, {
				MediaContainer: {
					totalSize: 1,
					Metadata: [{
						ratingKey: '9',
						title: 'Film',
						Media: [{
							duration: 50_000,
							Part: [{ id: 1, file: '/a.mkv' }, { id: 2, file: '/b.mkv' }],
						}],
					}],
				},
			}),
		]), {
			provider: 'plex',
			baseUrl: 'http://plex.test',
			accessToken: 'secret-token',
			clientIdentifier: 'moirai-client',
			allowInsecureTls: false,
		});
		const [item] = await plex.listItems('1', 'movies');
		expect(item?.parts.map((part) => part.durationMilliseconds)).toEqual([null, null]);
	});

	it('drops external Jellyfin subtitles and keeps a media source id that contains a colon', async () => {
		const jellyfin = new JellyfinClient(async () => jsonResponse(200, {
			Items: [{
				Id: 'movie-1',
				Name: 'Film',
				Type: 'Movie',
				RunTimeTicks: 50_000_000_0,
				MediaSources: [
					{ Id: 'main:source', Path: '/a.mkv', RunTimeTicks: 20_000_000_0, MediaStreams: [
						{ Index: 0, Type: 'Video', Codec: 'h264' },
						{ Index: 1, Type: 'Subtitle', Codec: 'srt', IsExternal: true },
					] },
					{ Id: 'extra', Path: '/b.mkv', MediaStreams: [] },
				],
			}],
			TotalRecordCount: 1,
		}), {
			provider: 'jellyfin',
			baseUrl: 'http://jellyfin.test',
			accessToken: 'secret-token',
			clientIdentifier: 'moirai-client',
			allowInsecureTls: false,
		});
		const [item] = await jellyfin.listItems('library', 'movies');
		expect(item?.parts[0]?.streams.map((stream) => stream.type)).toEqual(['video']);
		expect(item?.parts).toHaveLength(1);
		expect(jellyfin.streamRequest('movie-1:main:source').url).toContain('MediaSourceId=main%3Asource');
	});

	it('leaves omitted media-server update fields unset', () => {
		const parsed = mediaServerUpdateSchema.parse({ name: 'Renamed' });
		expect(parsed.pathReplacements).toBeUndefined();
		expect(parsed.allowInsecureTls).toBeUndefined();
	});

	it('skips ffprobe when the mapped file fingerprint is unchanged', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-probe-'));
		roots.push(root);
		const file = path.join(root, 'Arrival.mkv');
		await writeFile(file, 'video');
		let calls = 0;
		const probe = {
			probe: async () => {
				calls += 1;
				return {
					durationMilliseconds: 1_000,
					chapters: [],
					chapterLimitExceeded: false,
					fileSizeBytes: 5,
					container: 'mkv',
					streams: [],
					resolution: null,
					tags: {},
				};
			},
		} as unknown as MediaProbe;
		const input = {
			libraryId: LIBRARY_ID,
			mediaServerId: SERVER_ID,
			replacements: [{ remotePrefix: '/data/movies', localPrefix: root }],
			probe,
			items: [{
				id: '42',
				etag: '1',
				kind: 'movie' as const,
				title: 'Arrival',
				sortTitle: null,
				plot: null,
				year: null,
				show: null,
				seasonNumber: null,
				seasonTitle: null,
				episodeNumber: null,
				artists: [],
				album: null,
				albumId: null,
				trackNumber: null,
				genres: [],
				directors: [],
				actors: [],
				externalIds: [],
				parts: [{ id: '7', filePath: '/data/movies/Arrival.mkv', durationMilliseconds: null, sizeBytes: 5, container: 'mkv', streams: [], chapters: [] }],
				posterPath: null,
				landscapePath: null,
				fanartPath: null,
				modifiedAt: '2026-08-23T00:00:00.000Z',
			}],
		};
		const first = await buildRemoteCatalog(input);
		const second = await buildRemoteCatalog({
			...input,
			probeCache: new Map([[first.items[0]!.relativePath, {
				relativePath: first.items[0]!.relativePath,
				probeFingerprint: first.items[0]!.probeFingerprint,
				durationMilliseconds: first.items[0]!.durationMilliseconds,
				probeStatus: 'complete' as const,
				probeUpdatedAt: null,
				probeErrorCode: null,
				technicalMetadata: first.items[0]!.technicalMetadata,
			}]]),
		});
		expect(calls).toBe(1);
		expect(second.items[0]?.durationMilliseconds).toBe(1_000);
	});
});

it.each([
	['invalid total', /invalid library total/],
	['missing later total', /stopped reporting its library total/],
	['missing envelope', /library listing/],
	['unconfirmed empty page', /library listing/],
	['unidentified file', /identify every file/],
] as const)('preserves the persisted catalog after a provider listing with %s', async (failure, problem) => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	const repository = new Repository(database.db);
	let invalid = false;
	let invalidRequests = 0;
	const adapter = new MediaServerSourceAdapter(
		'plex',
		repository.mediaServers,
		undefined,
		() => async () => {
			if (!invalid) {
				return moviePage();
			}
			if (failure === 'invalid total') {
				return { ...jsonResponse(200, {}), text: async () => '{"MediaContainer":{"totalSize":1e400,"Metadata":[]}}' };
			}
			if (failure === 'missing envelope') {
				return jsonResponse(200, {});
			}
			if (failure === 'unconfirmed empty page') {
				return jsonResponse(200, { MediaContainer: {} });
			}
			if (failure === 'unidentified file') {
				return jsonResponse(200, {
					MediaContainer: { totalSize: 1, Metadata: [{ ratingKey: '42', title: 'Arrival',
						Media: [{ Part: [{ id: 7, duration: 120_000 }, { duration: 90_000 }] }] }] },
				});
			}

			invalidRequests += 1;
			return invalidRequests === 1
				? jsonResponse(200, { MediaContainer: { totalSize: 2, Metadata: [{ ratingKey: '42', title: 'Arrival' }] } })
				: jsonResponse(200, { MediaContainer: { Metadata: [] } });
		},
	);
	const manager = new ScannerManager(repository, { publish: () => undefined }, new LibrarySourceRegistry([adapter]));
	try {
		const provider = connection();
		const server = await repository.mediaServers.createMediaServer(provider, { ...provider, libraries: [] });
		const definition = libraryCreateSchema.parse(library());
		const saved = await repository.createLibrary(libraryCreateSchema.parse({ ...definition,
			sourceConfig: { ...definition.sourceConfig, mediaServerId: server.id } }));
		expect((await manager.scan(saved.id, 'initial')).status).toBe('complete');
		const previous = database.sqlite.prepare('SELECT * FROM media_items').all();
		expect(previous).toHaveLength(1);
		invalid = true;
		const failed = await manager.scan(saved.id, 'manual');
		expect(failed.status).toBe('failed');
		expect(database.sqlite.prepare('SELECT * FROM media_items').all()).toEqual(previous.map((item) => ({ ...(item as Record<string, unknown>), availability: 'unconfirmed' })));
		expect(failed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringMatching(problem) })]));
		expect(failed.removedCount).toBe(0);
	}
	finally {
		await manager.close();
		database.close();
	}

});

it.each(['jellyfin', 'emby'] as const)('requires a conclusive %s item response before counting absence', async (provider) => {
	let upstream = jsonResponse(200, {});
	const client = new JellyfinClient(async () => upstream, { ...connection(), provider });
	await expect(client.listItems('movies', 'movies')).rejects.toThrow(/item list/);
	await expect(client.itemExists('item')).rejects.toThrow(/item list/);

	upstream = jsonResponse(404, {});
	await expect(client.itemExists('item')).rejects.toMatchObject({ status: 404 });
	upstream = jsonResponse(200, { Items: [{ Id: 'another-item' }] });
	await expect(client.itemExists('item')).rejects.toThrow(/conclusive/);
	upstream = jsonResponse(200, { Items: [], TotalRecordCount: 1 });
	await expect(client.itemExists('item')).rejects.toThrow(/conclusive/);
	upstream = jsonResponse(200, { Items: [{ Id: 'item' }] });
	await expect(client.itemExists('item')).resolves.toBe(true);
	upstream = jsonResponse(200, { Items: [], TotalRecordCount: 0 });
	await expect(client.itemExists('item')).resolves.toBe(false);
	await expect(client.listItems('movies', 'movies')).resolves.toEqual([]);
});

it.each(['jellyfin', 'emby'] as const)('uses one preferred %s version instead of concatenating alternate versions', async (provider) => {
	const client = new JellyfinClient(async () => jsonResponse(200, {
		TotalRecordCount: 1,
		Items: [{ Id: 'movie', Name: 'Film', Type: 'Movie', MediaSources: [
			{ Id: 'preferred', Path: '/preferred.mkv', RunTimeTicks: 36_000_000_000 },
			{ Id: 'alternate', Path: '/alternate.mkv', RunTimeTicks: 37_000_000_000 },
		] }],
	}), { ...connection(), provider });
	const [item] = await client.listItems('library', 'movies');
	expect(item?.parts).toHaveLength(1);
	expect(item?.parts[0]).toMatchObject({ durationMilliseconds: 3_600_000, filePath: '/preferred.mkv' });
	expect(client.streamRequest('movie:preferred').url).toContain('MediaSourceId=preferred');
	const catalog = await buildRemoteCatalog({ libraryId: LIBRARY_ID, mediaServerId: SERVER_ID, items: item ? [item] : [], replacements: [] });
	expect(catalog.items).toHaveLength(1);
	expect(catalog.items[0]?.durationMilliseconds).toBe(3_600_000);
	expect(catalog.items[0]?.playbackPath).toBe(`moirai-remote:${SERVER_ID}/movie%3Apreferred`);
});


it('matches POSIX mapping prefixes exactly and folds Windows drive and UNC prefixes only', () => {
	const unix = [{ remotePrefix: '/media/Movies', localPrefix: '/mapped/movies' }];
	expect(localPathForRemote(unix, '/media/movies/Film.mkv')).toBeNull();
	expect(localPathForRemote(unix, '/media/Movies/Film.mkv')).toBe(path.resolve('/mapped/movies/Film.mkv'));
	expect(localPathForRemote([{ remotePrefix: 'D:\\Media\\Movies', localPrefix: '/mapped' }], 'd:\\media\\movies\\Film.mkv')).toBe(path.resolve('/mapped/Film.mkv'));
	expect(localPathForRemote([{ remotePrefix: '\\\\NAS\\Media', localPrefix: '/mapped' }], '\\\\nas\\media\\Film.mkv')).toBe(path.resolve('/mapped/Film.mkv'));
	expect(localPathForRemote([{ remotePrefix: '/media', localPrefix: '/' }], '/media/film.mkv')).toBe(path.resolve('/film.mkv'));
	expect(localPathForRemote([{ remotePrefix: '/', localPrefix: '/mapped' }], '/media/film.mkv')).toBe(path.resolve('/mapped/media/film.mkv'));
});
