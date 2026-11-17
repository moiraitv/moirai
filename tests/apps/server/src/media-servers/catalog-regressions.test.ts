import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { libraryCreateSchema, mediaServerCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { parseMediaProbeOutput } from '@server/media/media-probe.js';
import { buildRemoteCatalog, type RemoteCatalog } from '@server/media-servers/catalog.js';
import type { RemoteMediaItem } from '@server/media-servers/items.js';
import type { MediaProbe, MediaProbeResult } from '@server/media/media-probe.js';
import type { MediaProbeCacheEntry } from '@server/repository/contracts.js';
import { MEDIA_DURATION_MISMATCH_TOLERANCE_MILLISECONDS } from '@server/scanner/media-duration-health.js';

const libraryId = '22222222-2222-4222-8222-222222222222';
const mediaServerId = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** Construct one provider item with stable remote identity and a mapped physical file. */
function movie(id: string, filePath: string): RemoteMediaItem {
	return {
		id, etag: 'provider-version', kind: 'movie', title: id, sortTitle: null, plot: null, year: null,
		show: null, seasonNumber: null, seasonTitle: null, episodeNumber: null, artists: [], album: null,
		albumId: null, trackNumber: null, genres: [], directors: [], actors: [], externalIds: [],
		parts: [{ id: `part-${id}`, filePath, durationMilliseconds: 120_000, sizeBytes: 5, container: 'mkv', streams: [], chapters: [] }],
		posterPath: null, landscapePath: null, fanartPath: null, modifiedAt: '2026-01-15T00:00:00.000Z',
	};
}

/** Restore the cache projection supplied by the real scanner after a successful catalog commit. */
function probeCache(catalog: RemoteCatalog): Map<string, MediaProbeCacheEntry> {
	return new Map(catalog.items.map(item => [item.relativePath, {
		relativePath: item.relativePath, probeFingerprint: item.probeFingerprint,
		durationMilliseconds: item.durationMilliseconds, probeStatus: 'complete', probeUpdatedAt: null,
		probeErrorCode: null, technicalMetadata: item.technicalMetadata,
	}]));
}

it('keeps duration warnings and accepted tail findings when a mapped scan reuses its probe', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-remote-health-'));
	roots.push(root);
	await writeFile(path.join(root, 'movie.mkv'), 'video');
	const durationMilliseconds = MEDIA_DURATION_MISMATCH_TOLERANCE_MILLISECONDS * 4;
	const probeResult: MediaProbeResult = {
		durationMilliseconds, fileSizeBytes: 5, container: 'mkv', resolution: null, tags: {},
		streams: [
			{ index: 0, type: 'video', codec: 'h264', durationMilliseconds, startMilliseconds: 0, isAttachedPicture: false },
			{ index: 1, type: 'audio', codec: 'aac', durationMilliseconds: durationMilliseconds / 2, startMilliseconds: 0 },
		] as MediaProbeResult['streams'],
	};
	const probe = { probe: vi.fn(async () => probeResult) } as unknown as MediaProbe;
	const inspectTail = vi.fn(async () => 'black' as const);
	const input = {
		libraryId, mediaServerId, replacements: [{ remotePrefix: '/media', localPrefix: root }],
		items: [movie('first', '/media/movie.mkv')], probe, inspectTail,
	};
	const first = await buildRemoteCatalog(input);
	expect(first.issues).toHaveLength(1);
	expect(first.issues[0]).toMatchObject({ code: 'media_audio_video_duration_mismatch', tailAssessment: { result: 'black', accepted: false } });
	const accepted = { ...first.issues[0]!.tailAssessment!, accepted: true };
	const second = await buildRemoteCatalog({
		...input, probeCache: probeCache(first), tailAssessments: new Map([[first.issues[0]!.path!, accepted]]),
	});
	expect(second.issues).toEqual([{ ...first.issues[0]!, tailAssessment: accepted }]);
	expect(probe.probe).toHaveBeenCalledTimes(1);
	expect(inspectTail).toHaveBeenCalledTimes(1);

	// Local changes must not retain a prior tail decision just because the provider etag is unchanged.
	await writeFile(path.join(root, 'movie.mkv'), 'changed video');
	const changed = await buildRemoteCatalog({
		...input, probeCache: probeCache(second), tailAssessments: new Map([[first.issues[0]!.path!, accepted]]),
	});
	expect(probe.probe).toHaveBeenCalledTimes(2);
	expect(inspectTail).toHaveBeenCalledTimes(2);
	expect(changed.issues[0]?.tailAssessment?.accepted).toBe(false);
});

it('gives same-named VobSub sidecars distinct stable identities across mapped movies and servers', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-remote-sidecars-'));
	roots.push(root);
	for (const directory of ['first', 'second']) {
		const folder = path.join(root, directory);
		await mkdir(folder);
		await Promise.all(['mkv', 'idx', 'sub'].map(extension => writeFile(path.join(folder, `movie.${extension}`), directory)));
	}
	const input = {
		libraryId, mediaServerId, replacements: [{ remotePrefix: '/media', localPrefix: root }],
		items: [movie('first', '/media/first/movie.mkv'), movie('second', '/media/second/movie.mkv')],
	};
	const first = await buildRemoteCatalog(input);
	const tracks = first.items.map(item => item.subtitleTracks.find(track => track.format === 'vobsub')!);
	expect(tracks.every(Boolean)).toBe(true);
	expect(new Set(tracks.map(track => track.id)).size).toBe(2);
	for (const [index, directory] of ['first', 'second'].entries()) {
		expect(tracks[index]!.playbackPaths).toEqual(['idx', 'sub'].map(extension => path.join(root, directory, `movie.${extension}`)));
	}
	const repeated = await buildRemoteCatalog(input);
	expect(repeated.items.map(item => item.subtitleTracks[0]?.id)).toEqual(tracks.map(track => track.id));
	const anotherServer = await buildRemoteCatalog({ ...input, mediaServerId: '33333333-3333-4333-8333-333333333333' });
	expect(new Set([...tracks, ...anotherServer.items.flatMap(item => item.subtitleTracks)].map(track => track.id)).size).toBe(4);
});


it.each(['duration', 'probe'] as const)('persists ignored mapped %s warnings through reconciliation and expires only changed files', async (failure) => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-mapped-ignore-'));
	roots.push(root);
	const names = ['first.mkv', 'second.mkv'];
	await Promise.all(names.map(name => writeFile(path.join(root, name), 'video')));
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const server = await repository.mediaServers.createMediaServer(mediaServerCreateSchema.parse({
			provider: 'plex', name: 'Mapped server', baseUrl: 'https://plex.example', accessToken: 'synthetic-token',
		}), { serverKey: 'mapped-server', serverName: 'Mapped server', libraries: [] });
		const library = await repository.createLibrary(libraryCreateSchema.parse({
			name: 'Mapped movies', typeKey: 'movies', sourceType: 'plex',
			sourceConfig: { mediaServerId: server.id, remoteLibraryId: 'movies', remoteLibraryName: 'Movies' },
		}));
		const duration = MEDIA_DURATION_MISMATCH_TOLERANCE_MILLISECONDS * 4 / 1_000;
		const probeResult = parseMediaProbeOutput(JSON.stringify({ streams: [
			{ codec_type: 'video', codec_name: 'h264', index: 0, duration: String(duration), start_time: '0' },
			{ codec_type: 'audio', codec_name: 'aac', index: 1, duration: String(duration / 2), start_time: '0' },
		] }), 5);
		const probe = { probe: vi.fn(async () => {
			if (failure === 'probe') {
				throw new Error('Synthetic mapped probe failure');
			}
			return probeResult;
		}) } as unknown as MediaProbe;
		const firstMovie = movie('first', '/media/first.mkv');
		const remote = { ...firstMovie, parts: names.map((name, index) => ({ ...firstMovie.parts[0]!, id: `part-${index}`, filePath: `/media/${name}` })) };
		const inspectTail = vi.fn(async () => 'not-black' as const);
		/** Exercise cache retrieval, discovery, persistence, and ignore reapplication as one scan. */
		async function scan(refreshProbe = false) {
			const run = await repository.beginScan(library.id, 'manual');
			const found = await buildRemoteCatalog({
				libraryId: library.id, mediaServerId: server.id, items: [remote], probe, inspectTail,
				replacements: [{ remotePrefix: '/media', localPrefix: root }],
				probeCache: refreshProbe ? new Map() : new Map((await repository.listMediaProbeCache(library.id)).map(entry => [entry.relativePath, entry])),
				tailAssessments: await repository.listTailAssessments(library.id),
			});
			return repository.reconcileScan(run, found.groups, found.items, found.issues, true, {
				sourceType: 'plex', sourceKey: server.id, details: {},
			});
		}
		const first = await scan();
		expect(first.issues).toHaveLength(names.length);
		const code = failure === 'duration' ? 'media_audio_video_duration_mismatch' : 'media_probe_failed';
		for (const issue of first.issues) {
			expect(issue.code).toBe(code);
			expect(issue.ignoreState).toMatchObject({ ignored: false, fingerprint: expect.any(String) });
			expect(repository.setMediaIssueIgnored(library.id, issue.path!, issue.code, issue.ignoreState!.fingerprint, true)).toBe(true);
		}
		const second = await scan();
		expect(second.issues.map(issue => issue.ignoreState)).toEqual(first.issues.map(issue => ({ ...issue.ignoreState!, ignored: true })));
		expect((await repository.getLibrary(library.id))?.warningCount).toBe(0);
		if (failure === 'duration') {
			expect(probe.probe).toHaveBeenCalledTimes(names.length);
			expect(second.issues.every(issue => issue.tailAssessment?.accepted)).toBe(true);
		}

		// Technical cache invalidation must not reset decisions about unchanged physical files.
		const refreshed = await scan(true);
		expect(refreshed.issues.every(issue => issue.ignoreState?.ignored)).toBe(true);

		// A provider etag can stay unchanged even when the mapped physical file was replaced.
		await writeFile(path.join(root, names[0]!), 'changed video');
		const changed = await scan();
		const replaced = changed.issues.find(issue => issue.path === first.issues[0]!.path)!;
		const untouched = changed.issues.find(issue => issue.path === first.issues[1]!.path)!;
		expect(replaced.ignoreState?.fingerprint).not.toBe(first.issues[0]!.ignoreState!.fingerprint);
		expect(replaced.ignoreState?.ignored).toBe(false);
		expect(untouched.ignoreState).toEqual({ ...first.issues[1]!.ignoreState!, ignored: true });
		expect((await repository.getLibrary(library.id))?.warningCount).toBe(1);
		if (failure === 'duration') {
			expect(replaced.tailAssessment?.accepted).toBe(false);
			expect(untouched.tailAssessment?.accepted).toBe(true);
		}
	}
	finally {
		database.close();
	}
});
