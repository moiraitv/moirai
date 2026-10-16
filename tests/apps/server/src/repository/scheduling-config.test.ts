import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { channelCreateSchema, scheduleTemplateCreateSchema } from '@moirai/shared';
import { eq } from 'drizzle-orm';
import type { ProgramConfig } from '@moirai/shared';
import { loadConfig } from '@server/config.js';
import { createDatabase } from '@server/db/index.js';
import { channelSchedules, schedulingPrograms } from '@server/db/schema.js';
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


it('reads legacy schedule defaults and persists duplicate opt-out through saves and template reassignment', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Ordered' }));
		const slotId = randomUUID();
		const template = await repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({ name: 'Daily', slots: [{ id: slotId, startSeconds: 0, programId: null, filler: { mode: 'disabled' } }], boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: 86400 }] }));
		const legacy = { defaultTemplateId: template.id, layers: [], defaultFiller: null };
		await database.db.insert(channelSchedules).values({ channelId: channel.id, defaultTemplateId: template.id, config: legacy });
		const current = (await repository.getChannelSchedule(channel.id))!;
		expect(current.avoidCrossChannelDuplicates ?? true).toBe(true);
		expect((await repository.listChannelSchedules())[0]!.avoidCrossChannelDuplicates ?? true).toBe(true);
		await repository.setChannelSchedule(channel.id, { ...current, avoidCrossChannelDuplicates: false });
		const read = (await repository.getChannelSchedule(channel.id))!;
		expect(read.avoidCrossChannelDuplicates).toBe(false);
		await repository.setChannelSchedule(channel.id, { ...read, defaultFiller: null });
		await repository.setTemplateAssignments(template.id, [channel.id]);
		expect((await repository.getChannelSchedule(channel.id))!.avoidCrossChannelDuplicates).toBe(false);
		const [stored] = await database.db.select().from(channelSchedules).where(eq(channelSchedules.channelId, channel.id));
		expect(stored!.config.avoidCrossChannelDuplicates).toBe(false);
		expect(stored!.config.defaultTemplateId).toBe(template.id);
	}
	finally {
		database.close();
	}
});
