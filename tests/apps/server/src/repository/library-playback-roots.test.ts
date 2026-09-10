import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '@server/db/index.js';
import { libraries } from '@server/db/schema.js';
import { Repository } from '@server/repository/index.js';

it('batches distinct requested library roots and falls back to scan roots without catalog joins', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const rows = Array.from({ length: 502 }, (_, index) => ({
			id: randomUUID(), name: `Library ${index}`, nameKey: `library ${index}`, typeKey: 'movies', sourceType: 'on-disk',
			sourceConfig: { scanRoot: `/scan/${index}`, playbackRoot: index % 2 ? `/mapped/${index}` : null },
			scanIntervalMinutes: 15, watcherEnabled: false, enabled: true, createdAt: '', updatedAt: '',
		}));
		for (const row of rows) {
			await database.db.insert(libraries).values(row);
		}
		const repo = new Repository(database.db);
		const select = vi.spyOn(database.db, 'select');
		expect(await repo.getLibraryPlaybackRoots([])).toEqual(new Map());
		expect(select).not.toHaveBeenCalled();
		const requested = rows.slice(0, 501);
		const roots = await repo.getLibraryPlaybackRoots([...requested.map((row) => row.id), requested[0]!.id, randomUUID()]);
		expect(select).toHaveBeenCalledTimes(2);
		expect(roots).toEqual(new Map(requested.map((row) => [row.id, row.sourceConfig.playbackRoot ?? row.sourceConfig.scanRoot])));
	}
	finally {
		database.close();
	}
});
