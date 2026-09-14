import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { catalogProgramItemQuerySchema, libraryCreateSchema, programCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { mediaMatchesLibraryQuery, libraryQueryStateSource } from '@server/scheduling/content-query.js';
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
		const catalog = await repository.getSchedulingCatalog([{ ...program, config: { type: 'content', source: { type: 'library-query', libraryId: library.id, kinds: [], genres: [] }, strategy: { type: 'sequential' } } }]);
		for (const filter of [{ artist: 'Guest' }, { artist: 'ARTIST', album: 'ALBUM' }, { album: 'missing' }]) {
			const browsed = await repository.browseMedia(library.id, { ...query, ...filter });
			const scheduled = catalog.media.filter(media => mediaMatchesLibraryQuery(media, {
				type: 'library-query', libraryId: library.id, kinds: [], genres: [], ...filter,
			}));
			expect(browsed.items.map(item => item.id).sort()).toEqual(scheduled.map(item => item.id).sort());
		}
		for (const [search, field] of [['Guest', 'artist'], ['The Album', 'album'], ['The Artist', 'artist']] as const) {
			const browsed = await repository.browseMedia(library.id, { ...query, search, parentId: artist.id });
			expect(browsed.items.length).toBeGreaterThan(0);
			expect(browsed.entries.every(entry => entry.matches?.some(match => match.field === field))).toBe(true);
			const picked = await repository.browseMediaSourceOptions(library.id, { target: 'items', search, parentId: artist.id, page: 1, pageSize: 50 });
			expect(picked.entries.map(entry => entry.item?.id)).toEqual(browsed.items.map(item => item.id));
		}
		const legacy = { type: 'library-query' as const, libraryId: library.id, kinds: [], genres: [] };
		expect(libraryQueryStateSource({ ...legacy, artist: '', album: '' })).toEqual(libraryQueryStateSource(legacy));

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

it('matches Unicode music filters and search consistently across credits, ancestors, and scheduling', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-music-unicode-'));
	const database = createDatabase(path.join(root, 'test.sqlite'), path.resolve('drizzle'));
	try {
		const source = path.join(root, 'videos');
		await mkdir(source);
		const repository = new Repository(database.db);
		const library = await repository.createLibrary(libraryCreateSchema.parse({ name: 'Music', typeKey: 'music-videos', sourceType: 'on-disk', sourceConfig: { scanRoot: source, playbackRoot: '/videos' } }));
		for (const name of ['Credits', 'Ancestors', 'Unknown']) {
			await writeFile(path.join(source, `${name}.mp4`), 'video');
		}
		await writeFile(path.join(source, 'Credits.nfo'), '<musicvideo><title>Credits</title><artist>Other</artist><artist>Björk %_\\</artist><album>Début %_\\</album></musicvideo>');
		await writeFile(path.join(source, 'Ancestors.nfo'), '<musicvideo><title>Ancestors</title><artist>Björk %_\\</artist><album>Début %_\\</album></musicvideo>');
		const discovery = await discoverOnDisk(library, { probeMedia: async () => ({ durationMilliseconds: 180_000, fileSizeBytes: 5, container: 'mp4', streams: [], resolution: null, tags: {} }) });
		const items = discovery.items.map(item => {
			if (item.title !== 'Ancestors') {
				return item;
			}
			const metadata = { ...item.metadata };
			delete metadata.album;
			return { ...item, artists: [], metadata };
		});
		await repository.reconcileScan(await repository.beginScan(library.id, 'initial'), discovery.groups, items, discovery.issues, true);
		const program = await repository.createProgram(programCreateSchema.parse({
			name: 'Music query', config: { type: 'content', source: { type: 'library-query', libraryId: library.id, kinds: [], genres: [] }, strategy: { type: 'sequential' } },
		}));
		const catalog = await repository.getSchedulingCatalog([program]);
		const query = { ...catalogProgramItemQuerySchema.parse({}), page: 1, pageSize: 50, sort: 'title' as const, direction: 'asc' as const };
		const expected = items.filter(item => item.title !== 'Unknown').map(item => item.id).sort();
		for (const filter of [{ artist: 'BJÖRK' }, { album: 'DÉBUT' }, { artist: 'BJÖRK %_\\', album: 'DÉBUT %_\\' }, { artist: 'BJORK' }, { album: 'DEBUT' }, { artist: '%missing_' }]) {
			const browsed = await repository.browseMedia(library.id, { ...query, ...filter });
			const scheduled = catalog.media.filter(media => mediaMatchesLibraryQuery(media, {
				type: 'library-query', libraryId: library.id, kinds: [], genres: [], ...filter,
			}));
			const ids = browsed.items.map(item => item.id).sort();
			expect(ids).toEqual(scheduled.map(item => item.id).sort());
			expect(ids).toEqual(filter.artist?.includes('BJÖRK') || filter.album === 'DÉBUT' ? expected : []);
			expect(repository.resolveProgramItemSelection(library.id, { ...query, ...filter }).itemIds.sort()).toEqual(ids);
		}
		for (const [search, field] of [['BJÖRK', 'artist'], ['DÉBUT', 'album'], ['%_\\', 'artist']] as const) {
			const browsed = await repository.browseMedia(library.id, { ...query, search });
			expect(browsed.items.map(item => item.id).sort()).toEqual(expected);
			expect(browsed.entries.every(entry => entry.matches?.some(match => match.field === field))).toBe(true);
			const picked = await repository.browseMediaSourceOptions(library.id, { target: 'items', search, parentId: null, page: 1, pageSize: 50 });
			expect(picked.entries.map(entry => entry.item?.id).sort()).toEqual(expected);
			expect(picked.entries.every(entry => entry.matches?.some(match => match.field === field))).toBe(true);
			expect(repository.resolveProgramItemSelection(library.id, { ...query, search }).itemIds.sort()).toEqual(expected);
		}
	}
	finally {
		database.close();
		await rm(root, { recursive: true, force: true });
	}
});
