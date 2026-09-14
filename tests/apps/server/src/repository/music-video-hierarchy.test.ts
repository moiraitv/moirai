import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { catalogProgramItemQuerySchema, libraryCreateSchema, programCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { discoverOnDisk } from '@server/scanner/on-disk.js';

it('rescans loose music videos into stable artist/album/song browsing without replacing songs', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-music-hierarchy-'));
	const database = createDatabase(path.join(root, 'test.sqlite'), path.resolve('drizzle'));
	try {
		const source = path.join(root, 'videos');
		await mkdir(source);
		const repository = new Repository(database.db);
		const library = await repository.createLibrary(libraryCreateSchema.parse({ name: 'Music', typeKey: 'music-videos', sourceType: 'on-disk', sourceConfig: { scanRoot: source, playbackRoot: '/videos' } }));
		for (const name of ['One', 'Two', 'Unknown']) {
			await writeFile(path.join(source, `${name}.mp4`), 'video');
		}
		await writeFile(path.join(source, 'One.nfo'), '<musicvideo><title>First Song</title><artist>The Artist</artist><album>The Album</album></musicvideo>');
		const probeMedia = async (_root: string, file: string) => ({
			durationMilliseconds: 180_000, fileSizeBytes: 5, container: 'mp4', streams: [], resolution: null,
			tags: path.basename(file) === 'Unknown.mp4' ? {} : { artist: 'the artist; Guest', album: 'the album' },
		});
		const discovery = await discoverOnDisk(library, { probeMedia });
		// Model the previous scanner's persisted flat catalog, then execute a normal rescan.
		const prior = discovery.items.map(item => ({ ...item, groupId: null, fingerprint: 'metadata:10:flat-catalog' }));
		await repository.reconcileScan(await repository.beginScan(library.id, 'initial'), [], prior, [], true);
		const program = await repository.createProgram(programCreateSchema.parse({
			name: 'Preserved selection', config: { type: 'content', source: { type: 'item', itemId: prior[0]!.id }, strategy: { type: 'sequential' } },
		}));
		const query = { ...catalogProgramItemQuerySchema.parse({}), page: 1, pageSize: 50, sort: 'title' as const, direction: 'asc' as const };
		expect((await repository.browseMedia(library.id, query)).items).toHaveLength(3);

		const rescanned = await discoverOnDisk(library, { probeMedia });
		await repository.reconcileScan(await repository.beginScan(library.id, 'manual'), rescanned.groups, rescanned.items, rescanned.issues, true);
		const artists = await repository.browseMedia(library.id, query);
		expect(artists.items).toHaveLength(0);
		expect(artists.groups.map(group => group.title)).toEqual(['The Artist', 'Unknown artist']);
		const artist = artists.groups.find(group => group.title === 'The Artist')!;
		expect(artist.childCount).toBe(1);
		const albums = await repository.browseMedia(library.id, { ...query, parentId: artist.id });
		expect(albums.groups).toMatchObject([{ kind: 'album', title: 'The Album', childCount: 2 }]);
		const songs = await repository.browseMedia(library.id, { ...query, parentId: albums.groups[0]!.id });
		expect(songs.items.map(item => item.title)).toEqual(['First Song', 'Two']);
		expect(songs.items.map(item => item.id).sort()).toEqual(prior.filter(item => item.relativePath !== 'Unknown.mp4').map(item => item.id).sort());
		expect(songs.items.every(item => item.playbackPath.startsWith('/videos/'))).toBe(true);
		const unknownAlbums = await repository.browseMedia(library.id, { ...query, parentId: artists.groups.find(group => group.title === 'Unknown artist')!.id });
		expect(unknownAlbums.groups[0]?.title).toBe('Unknown album');
		const filtered = await repository.browseMedia(library.id, { ...query, parentId: artist.id, name: 'First' });
		expect(filtered.items.map(item => item.title)).toEqual(['First Song']);
		expect(rescanned.groups.map(group => group.id)).toEqual(discovery.groups.map(group => group.id));
		expect((await repository.getProgram(program.id))?.config).toEqual(program.config);

		// A newly indexed folder must enrich the already selected metadata groups in place.
		const albumId = albums.groups[0]!.id;
		const groupedProgram = await repository.createProgram(programCreateSchema.parse({
			name: 'Album selection', config: { type: 'content', source: { type: 'group-collection', libraryId: library.id, groupIds: [albumId] }, strategy: { type: 'sequential' } },
		}));
		const folder = path.join(source, 'The Artist', 'The Album');
		await mkdir(folder, { recursive: true });
		await writeFile(path.join(folder, 'Three.mp4'), 'video');
		for (let pass = 0; pass < 2; pass++) {
			const updated = await discoverOnDisk(library, { probeMedia });
			await repository.reconcileScan(await repository.beginScan(library.id, 'manual'), updated.groups, updated.items, updated.issues, true);
			const currentArtists = (await repository.browseMedia(library.id, query)).groups;
			expect(currentArtists).toHaveLength(2);
			expect(currentArtists.find(group => group.id === artist.id)).toBeDefined();
			const currentAlbums = (await repository.browseMedia(library.id, { ...query, parentId: artist.id })).groups;
			expect(currentAlbums).toHaveLength(1);
			expect(currentAlbums[0]!.id).toBe(albumId);
			const currentSongs = (await repository.browseMedia(library.id, { ...query, parentId: albumId })).items;
			expect(currentSongs).toHaveLength(3);
			expect(currentSongs.map(item => item.id)).toEqual(expect.arrayContaining(songs.items.map(item => item.id)));
			expect((await repository.getProgram(groupedProgram.id))?.config).toEqual(groupedProgram.config);
		}

	}
	finally {
		database.close();
		await rm(root, { recursive: true, force: true });
	}
});
