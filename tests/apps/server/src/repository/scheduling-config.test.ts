import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProgramConfig } from '@moirai/shared';
import { loadConfig } from '@server/config.js';
import { createDatabase } from '@server/db/index.js';
import { schedulingPrograms } from '@server/db/schema.js';
import { Repository } from '@server/repository/index.js';

describe('program configuration compatibility', () => {
	it('does not synthesize addition batches during a legacy no-op collection edit', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-program-config-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		try {
			const repository = new Repository(database.db);
			const programId = randomUUID();
			const timestamp = '2026-09-01T12:00:00.000Z';
			const legacyConfig: ProgramConfig = {
				type: 'content',
				source: {
					type: 'collection',
					libraryId: randomUUID(),
					itemIds: [randomUUID(), randomUUID()],
					sort: { type: 'date-added', direction: 'asc' },
				},
				strategy: { type: 'sequential' },
			};
			await database.db.insert(schedulingPrograms).values({
				id: programId,
				name: 'Legacy Collection',
				nameKey: 'legacy collection',
				config: legacyConfig,
				createdAt: timestamp,
				updatedAt: timestamp,
			});

			const current = await repository.getProgram(programId);
			const updated = await repository.updateProgram(programId, {
				name: 'Renamed Legacy Collection',
				config: current!.config,
			});

			expect(updated?.config).toEqual(current?.config);
			expect(updated?.config.type === 'content'
				&& updated.config.source.type === 'collection'
				&& updated.config.source.additionBatches).toBeUndefined();
		}
		finally {
			database.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
