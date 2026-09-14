import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { libraryCreateSchema, programCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { discoverOnDisk } from '@server/scanner/on-disk.js';

it('appends valid groups atomically, preserves settings, and rejects incompatible destinations', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-program-groups-'));
	const database = createDatabase(path.join(root, 'test.sqlite'), path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const library = await repository.createLibrary(libraryCreateSchema.parse({ name: 'Shows', typeKey: 'shows', sourceType: 'on-disk', sourceConfig: { scanRoot: root } }));
		for (const season of [1, 2, 3]) {
			const directory = path.join(root, 'Show', `Season 0${season}`);
			await mkdir(directory, { recursive: true });
			await writeFile(path.join(directory, `Show S0${season}E01.mp4`), 'fixture');
		}
		const discovery = await discoverOnDisk(library, { probeMedia: async () => ({ durationMilliseconds: 60_000, fileSizeBytes: 7, container: 'mp4', streams: [], resolution: null, tags: {} }) });
		await repository.reconcileScan(await repository.beginScan(library.id, 'initial'), discovery.groups, discovery.items, [], true);
		const groups = discovery.groups.filter(group => group.kind === 'season');
		expect(groups).toHaveLength(3);
		const program = await repository.createProgram(programCreateSchema.parse({ name: 'Seasons', config: { type: 'content', source: { type: 'group-collection', libraryId: library.id, groupIds: [groups[0]!.id] }, strategy: { type: 'sequential' } } }));
		const result = repository.appendProgramGroups(program.id, library.id, [groups[0]!.id, groups[1]!.id]);
		expect(result).toMatchObject({ status: 'updated', addedGroupCount: 1, alreadySelectedCount: 1 });
		const saved = await repository.getProgram(program.id);
		expect(saved?.config).toMatchObject({ source: { groupIds: [groups[0]!.id, groups[1]!.id] }, strategy: program.config.type === 'content' ? program.config.strategy : undefined });
		expect(repository.appendProgramGroups(program.id, library.id, [groups[1]!.id])).toMatchObject({ status: 'updated', addedGroupCount: 0, program: { updatedAt: saved?.updatedAt } });
		expect(repository.appendProgramGroups(program.id, library.id, [groups[2]!.id, randomUUID()])).toEqual({ status: 'invalid-groups' });
		expect((await repository.getProgram(program.id))?.config).toEqual(saved?.config);
		expect(repository.appendProgramGroups(program.id, randomUUID(), [groups[2]!.id])).toEqual({ status: 'incompatible' });
		expect(repository.appendProgramGroups(randomUUID(), library.id, [groups[2]!.id])).toEqual({ status: 'not-found' });
		const items = await repository.createProgram(programCreateSchema.parse({ name: 'Items', config: { type: 'content', source: { type: 'collection', libraryId: library.id, itemIds: [discovery.items[0]!.id] }, strategy: { type: 'sequential' } } }));
		expect(repository.appendProgramGroups(items.id, library.id, [groups[2]!.id])).toEqual({ status: 'incompatible' });
	}
	finally {
		database.close();
		await rm(root, { recursive: true, force: true });
	}
});
