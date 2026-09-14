import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { libraryCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { discoverOnDisk } from '@server/scanner/on-disk.js';

it('prefers artist artwork, then the first album poster, then song artwork and refreshes on rescan', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-artist-art-'));
	const database = createDatabase(path.join(root, 'test.sqlite'), path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const library = await repository.createLibrary(libraryCreateSchema.parse({ name: 'Music', typeKey: 'music-videos', sourceType: 'on-disk', sourceConfig: { scanRoot: root } }));
		for (const artist of ['Own', 'Albums', 'Songs', 'Empty']) {
			for (const album of ['A', 'B']) {
				const directory = path.join(root, artist, album);
				await mkdir(directory, { recursive: true });
				await writeFile(path.join(directory, 'Song.mp4'), 'video');
				if (artist !== 'Empty') {
					await writeFile(path.join(directory, 'Song-poster.jpg'), 'song image');
				}
				if (artist === 'Own' || artist === 'Albums') {
					await writeFile(path.join(directory, 'poster.jpg'), 'album image');
				}
			}
		}
		await writeFile(path.join(root, 'Own', 'poster.jpg'), 'artist image');
		const probeMedia = async () => ({ durationMilliseconds: 60_000, fileSizeBytes: 5, container: 'mp4', streams: [], resolution: null, tags: {} });
		const first = await discoverOnDisk(library, { probeMedia });
		const artists = first.groups.filter(group => group.kind === 'artist');
		expect(artists.find(group => group.title === 'Own')?.artworkRelativePath).toBe('Own/poster.jpg');
		expect(artists.find(group => group.title === 'Albums')?.artworkRelativePath).toBe('Albums/A/poster.jpg');
		expect(artists.find(group => group.title === 'Songs')?.artworkRelativePath).toBe('Songs/A/Song-poster.jpg');
		expect(artists.find(group => group.title === 'Empty')?.artworkRelativePath).toBeNull();
		await repository.reconcileScan(await repository.beginScan(library.id, 'initial'), first.groups, first.items, first.issues, true);
		const albumArtist = artists.find(group => group.title === 'Albums')!;
		const before = await repository.listMediaGroupsByIds(library.id, [albumArtist.id]);
		await rm(path.join(root, 'Albums', 'A', 'poster.jpg'));
		await rm(path.join(root, 'Albums', 'B', 'poster.jpg'));
		const rescanned = await discoverOnDisk(library, { probeMedia });
		expect(rescanned.groups.find(group => group.id === albumArtist.id)?.artworkRelativePath).toBe('Albums/A/Song-poster.jpg');
		await repository.reconcileScan(await repository.beginScan(library.id, 'manual'), rescanned.groups, rescanned.items, rescanned.issues, true);
		const after = await repository.listMediaGroupsByIds(library.id, [albumArtist.id]);
		expect(after[0]!.artworkUrl).not.toBe(before[0]!.artworkUrl);
	}
	finally {
		database.close();
		await rm(root, { recursive: true, force: true });
	}
});
