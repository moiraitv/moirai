import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { catalogProgramItemQuerySchema, libraryCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { discoverOnDisk } from '@server/scanner/on-disk.js';

it('uses the parent poster for groups without their own artwork across browsing and pickers', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-program-groups-'));
	const database = createDatabase(path.join(root, 'test.sqlite'), path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const library = await repository.createLibrary(libraryCreateSchema.parse({ name: 'Shows', typeKey: 'shows', sourceType: 'on-disk', sourceConfig: { scanRoot: root } }));
		for (const season of [0, 1, 2]) {
			const directory = path.join(root, 'Show', `Season 0${season}`);
			await mkdir(directory, { recursive: true });
			await writeFile(path.join(directory, `Show S0${season}E01.mp4`), 'fixture');
		}
		const discovery = await discoverOnDisk(library, { probeMedia: async () => ({ durationMilliseconds: 60_000, fileSizeBytes: 7, container: 'mp4', streams: [], resolution: null, tags: {} }) });
		const show = discovery.groups.find(group => group.kind === 'show')!;
		show.artworkRelativePath = 'Show/poster.jpg';
		show.metadata = { ...show.metadata, artworkFingerprint: 'parent-version' };
		const seasons = discovery.groups.filter(group => group.kind === 'season');
		seasons[1]!.artworkRelativePath = 'Show/season01-poster.jpg';
		await repository.reconcileScan(await repository.beginScan(library.id, 'initial'), discovery.groups, discovery.items, [], true);
		const parent = (await repository.listMediaGroupsByIds(library.id, [show.id]))[0]!;
		expect(parent.artworkUrl).toContain(`/groups/${show.id}?`);
		const query = { ...catalogProgramItemQuerySchema.parse({}), parentId: show.id, page: 1, pageSize: 50, sort: 'title' as const, direction: 'asc' as const };
		const browsed = (await repository.browseMedia(library.id, query)).groups;
		const selected = await repository.listMediaGroupsByIds(library.id, seasons.map(group => group.id));
		const picked = (await repository.browseMediaSourceOptions(library.id, { target: 'groups', parentId: show.id, search: '', page: 1, pageSize: 50 })).entries.map(entry => entry.group!);
		for (const groups of [browsed, selected, picked]) {
			expect(groups.find(group => group.id === seasons[0]!.id)?.artworkUrl).toBe(parent.artworkUrl);
			expect(groups.find(group => group.id === seasons[1]!.id)?.artworkUrl).toContain(`/groups/${seasons[1]!.id}?`);
		}
		show.artworkRelativePath = null;
		await repository.reconcileScan(await repository.beginScan(library.id, 'manual'), discovery.groups, discovery.items, [], true);
		expect((await repository.listMediaGroupsByIds(library.id, [seasons[0]!.id]))[0]!.artworkUrl).toBeNull();
	}
	finally {
		database.close();
		await rm(root, { recursive: true, force: true });
	}
});
