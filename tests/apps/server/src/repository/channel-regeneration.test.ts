import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { quickChannelSetupCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { selectionStates } from '@server/db/schema.js';
import { similaritySeeds, similaritySeedItems } from '@server/db/semantic-schema.js';
import { Repository } from '@server/repository/index.js';
import { TimelineMaterializer } from '@server/scheduling/timeline-materializer.js';

it('clears only the selected channel history and retains its templates and regeneration seed across saves', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({ name: 'Movies', typeKey: 'movies', sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/media', playbackRoot: null }, scanIntervalMinutes: 15, watcherEnabled: false, enabled: true });
		const resources = ['1', '2'].map(number => repository.createQuickChannelSetup(quickChannelSetupCreateSchema.parse({
			scenario: 'movies', libraryId: library.id, programName: `Movies ${number}`,
			source: { type: 'library-query', genres: [] }, strategy: { type: 'shuffle', seed: '' },
			channel: { number, name: `Station ${number}` },
		}), 5_000));
		const materializer = new TimelineMaterializer(repository, { publish: () => {} }, 'UTC');
		await materializer.runNow();
		const timestamp = new Date().toISOString();
		for (const { channel, program } of resources) {
			database.db.insert(selectionStates).values({ consumerKey: channel.id, channelId: channel.id,
				configFingerprint: 'fixture', value: { type: 'sequential', nextIndex: 12, lastItemId: null }, updatedAt: timestamp }).run();
			database.db.insert(similaritySeeds).values({ consumerKey: channel.id, channelId: channel.id,
				programId: program.id, generation: 1, sourceItemIds: '[]', config: '{}', createdAt: timestamp }).run();
			database.db.insert(similaritySeedItems).values({ consumerKey: channel.id, generation: 1, mediaId: randomUUID(), ordinal: 0 }).run();
		}
		const selected = resources[0]!.channel.id;
		const other = resources[1]!.channel.id;
		const original = (await repository.getChannelSchedule(selected))!;
		const otherMaterialization = await repository.getTimelineMaterialization(other);
		const otherState = await repository.getSelectionState(other);
		const tables = ['materialized_timeline_segments', 'timeline_materializations', 'selection_states', 'similarity_seeds'];
		for (const table of tables) {
			expect((database.sqlite.prepare(`SELECT count(*) AS count FROM ${table} WHERE channel_id = ?`).get(selected) as { count: number }).count).toBeGreaterThan(0);
		}

		repository.resetChannelScheduleState(selected);

		for (const table of tables) {
			expect((database.sqlite.prepare(`SELECT count(*) AS count FROM ${table} WHERE channel_id = ?`).get(selected) as { count: number }).count).toBe(0);
		}
		expect(database.sqlite.prepare('SELECT * FROM similarity_seed_items WHERE consumer_key = ?').all(selected)).toEqual([]);
		expect(database.sqlite.prepare('SELECT * FROM similarity_seed_items WHERE consumer_key = ?').all(other)).toHaveLength(1);
		expect(await repository.getTimelineMaterialization(other)).toEqual(otherMaterialization);
		expect(await repository.getSelectionState(other)).toEqual(otherState);
		const reset = (await new Repository(database.db).getChannelSchedule(selected))!;
		expect(reset).toMatchObject({ defaultTemplateId: original.defaultTemplateId, layers: original.layers, defaultFiller: original.defaultFiller });
		expect(reset.generationSeed).toBeTruthy();
		expect(original.generationSeed).toBeUndefined();
		const saved = await repository.setChannelSchedule(selected, { ...original, generationSeed: randomUUID() });
		expect(saved?.generationSeed).toBe(reset.generationSeed);
		await repository.setTemplateAssignments(original.defaultTemplateId, [selected]);
		expect((await repository.getChannelSchedule(selected))?.generationSeed).toBe(reset.generationSeed);
		expect((await repository.listChannelSchedules()).find(schedule => schedule.channelId === selected)?.generationSeed).toBe(reset.generationSeed);
		expect(await repository.getProgram(resources[0]!.program.id)).toEqual(resources[0]!.program);
	}
	finally {
		database.close();
	}
});
