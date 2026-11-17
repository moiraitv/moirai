import path from 'node:path';
import { expect, it } from 'vitest';
import { libraryCreateSchema, mediaServerCreateSchema } from '@moirai/shared';
import { mediaItems } from '@server/db/schema.js';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { MediaServerPersistenceError } from '@server/repository/media-servers.js';

it('refuses to delete a server referenced by an accepted source or a pending source change', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const server = await repository.mediaServers.createMediaServer({
			provider: 'plex',
			name: 'Living room',
			baseUrl: 'http://plex.example:32400',
			accessToken: 'token-value-123456',
			allowInsecureTls: false,
			playbackReportingEnabled: false,
			pathReplacements: [],
		}, {
			serverKey: 'machine-1',
			serverName: 'Plex',
			libraries: [],
		});
		const unused = await repository.mediaServers.createMediaServer({
			provider: 'jellyfin',
			name: 'Unused',
			baseUrl: 'http://jellyfin.example:8096',
			accessToken: 'token-value-654321',
			allowInsecureTls: false,
			playbackReportingEnabled: false,
			pathReplacements: [],
		}, {
			serverKey: 'jellyfin-1',
			serverName: 'Jellyfin',
			libraries: [],
		});
		const folder = await repository.createLibrary({
			name: 'Folder',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/media/movies', playbackRoot: null },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		await repository.stageLibrarySourceChange(folder.id, {
			sourceType: 'plex',
			sourceConfig: {
				mediaServerId: server.id,
				remoteLibraryId: '1',
				remoteLibraryName: 'Movies',
			},
		}, folder);
		const accepted = await repository.createLibrary({
			name: 'Accepted',
			typeKey: 'shows',
			sourceType: 'plex',
			sourceConfig: {
				mediaServerId: server.id,
				remoteLibraryId: '2',
				remoteLibraryName: 'Shows',
			},
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});

		expect((await repository.mediaServers.libraryIdsForMediaServer(server.id)).sort()).toEqual(
			[folder.id, accepted.id].sort(),
		);
		await expect(repository.mediaServers.deleteMediaServer(server.id)).rejects.toBeInstanceOf(
			MediaServerPersistenceError,
		);
		expect(await repository.mediaServers.getMediaServer(server.id)).not.toBeNull();
		expect(await repository.mediaServers.deleteMediaServer(unused.id)).toBe(true);
		expect(await repository.mediaServers.getMediaServer(unused.id)).toBeNull();
	}
	finally {
		database.close();
	}
});

it.each(['plex', 'jellyfin'] as const)('keeps %s reporting opt-in and preserves it across partial updates', async (provider) => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const inspection = { serverKey: 'reporting-server', serverName: provider, libraries: [] };
		const server = await repository.mediaServers.createMediaServer(mediaServerCreateSchema.parse({
			provider, name: 'Reporting', baseUrl: `https://${provider}.example`,
			accessToken: 'synthetic-reporting-token', allowInsecureTls: false,
			pathReplacements: [],
		}), inspection);
		expect(server.playbackReportingEnabled).toBe(false);
		expect(await repository.mediaServers.playbackReportingConnections()).toEqual([]);
		await repository.mediaServers.updateMediaServer(server.id, { playbackReportingEnabled: true }, inspection);
		await repository.mediaServers.updateMediaServer(server.id, { name: 'Renamed' }, inspection);
		expect((await repository.mediaServers.getMediaServer(server.id))!.playbackReportingEnabled).toBe(true);
		expect(await repository.mediaServers.playbackReportingConnections()).toHaveLength(1);
		await repository.mediaServers.updateMediaServer(server.id, { playbackReportingEnabled: false }, inspection);
		expect(await repository.mediaServers.playbackReportingConnections()).toEqual([]);
	}
	finally {
		database.close();
	}
});

it('refuses unsupported reporting on create and update', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const inspection = { serverKey: 'emby-server', serverName: 'Emby', libraries: [] };
		const input = {
			provider: 'emby' as const, name: 'Emby', baseUrl: 'https://emby.example',
			accessToken: 'synthetic-token', allowInsecureTls: false,
			playbackReportingEnabled: true, pathReplacements: [],
		};
		await expect(repository.mediaServers.createMediaServer(input, inspection)).rejects.toMatchObject({ statusCode: 400 });
		const server = await repository.mediaServers.createMediaServer({ ...input, playbackReportingEnabled: false }, inspection);
		await expect(repository.mediaServers.updateMediaServer(server.id, { playbackReportingEnabled: true }, inspection)).rejects.toMatchObject({ statusCode: 400 });
		expect(await repository.mediaServers.playbackReportingConnections()).toEqual([]);
	}
	finally {
		database.close();
	}
});

it('resolves original Plex item keys and full durations together without treating local libraries as Plex', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const serverId = randomUUID();
		const plex = await repository.createLibrary(libraryCreateSchema.parse({
			name: 'Plex', typeKey: 'movies', sourceType: 'plex',
			sourceConfig: { mediaServerId: serverId, remoteLibraryId: '1', remoteLibraryName: 'Movies' },
		}));
		const local = await repository.createLibrary(libraryCreateSchema.parse({
			name: 'Folder', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: '/media' },
		}));
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		const now = new Date().toISOString();
		await database.db.insert(mediaItems).values(ids.map((id, index) => ({
			id, libraryId: index === 2 ? local.id : plex.id, stableKey: String(42 + index),
			kind: 'movie', title: 'Movie', sortTitle: 'Movie', relativePath: String(42 + index),
			playbackPath: 'moirai-remote:server/part', durationMilliseconds: 900_000,
			metadataStatus: 'complete', metadata: {}, dateAddedAt: now, fingerprint: 'fixture', createdAt: now, updatedAt: now,
		})));
		expect(await repository.mediaServers.plexPlaybackItems([])).toEqual([]);
		const items = await repository.mediaServers.plexPlaybackItems([...ids, randomUUID()]);
		expect(items).toHaveLength(2);
		expect(items).toEqual(expect.arrayContaining([
			{ id: ids[0], serverId, ratingKey: '42', durationMilliseconds: 900_000 },
			{ id: ids[1], serverId, ratingKey: '43', durationMilliseconds: 900_000 },
		]));
	}
	finally {
		database.close();
	}
});
