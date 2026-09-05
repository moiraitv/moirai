import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { quickChannelSetupCreateSchema, type QuickChannelSetupCreate } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';

const databases: Array<ReturnType<typeof createDatabase>> = [];

/** Create one migrated in-memory repository for Quick Setup tests. */
function repository(): Repository {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	return new Repository(database.db);
}

/** Create a matching library and return an empty-index Quick Setup request. */
async function fixture(subject: Repository, number = '1'): Promise<QuickChannelSetupCreate> {
	const library = await subject.createLibrary({
		name: `Movies ${number}`,
		typeKey: 'movies',
		sourceType: 'on-disk',
		sourceConfig: { scanRoot: `/media/${number}`, playbackRoot: null },
		scanIntervalMinutes: 15,
		watcherEnabled: false,
		enabled: true,
	});
	return quickChannelSetupCreateSchema.parse({
		scenario: 'movies',
		libraryId: library.id,
		programName: `Movie Programming ${number}`,
		source: { type: 'library-query', genres: [] },
		strategy: { type: 'shuffle', seed: '' },
		channel: { number, name: 'Movie Channel', group: 'Movies' },
	});
}

afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close();
	}
});

describe('quick channel setup repository', () => {
	it('prepares preview resources without writes or reserving conflicting names', async () => {
		const subject = repository();
		const request = await fixture(subject);
		const preview = subject.previewQuickChannelSetup(request, 5_000);
		expect(preview.template.slots[0]?.programId).toBe(preview.program.id);
		expect(await subject.listPrograms()).toEqual([]);
		expect(await subject.listScheduleTemplates()).toEqual([]);
		expect(await subject.listChannels()).toEqual([]);
		expect(await subject.listChannelSchedules()).toEqual([]);
		expect(await subject.getSelectionState(preview.channel.id)).toEqual([]);
		const created = subject.createQuickChannelSetup(request, 5_000);
		expect(created.program.config).toEqual(preview.program.config);
		expect(created.template.boundaries[0]).toMatchObject({ policy: 'finish-left', maxDriftSeconds: null });
		expect(() => subject.previewQuickChannelSetup(request, 5_000)).not.toThrow();
		expect(await subject.listPrograms()).toHaveLength(1);
	});

	it('creates a linked continuous program, template, channel, and schedule', async () => {
		const subject = repository();
		const result = subject.createQuickChannelSetup(await fixture(subject), 5_000);

		expect(result.program.config).toMatchObject({
			type: 'content',
			strategy: { type: 'shuffle' },
		});
		expect(result.template.slots).toEqual([expect.objectContaining({
			programId: result.program.id,
			startSeconds: 0,
			stateScope: 'persistent',
			startEligibility: { type: 'allow-overrun' },
		})]);
		expect(result.template.boundaries).toEqual([expect.objectContaining({
			leftSlotId: result.template.slots[0]!.id,
			rightSlotId: result.template.slots[0]!.id,
			policy: 'finish-left',
			maxDriftSeconds: null,
		})]);
		expect(result.schedule).toMatchObject({
			channelId: result.channel.id,
			defaultTemplateId: result.template.id,
			layers: [],
		});
		expect(await subject.listPrograms()).toHaveLength(1);
		expect(await subject.listScheduleTemplates()).toHaveLength(1);
		expect(await subject.listChannels()).toHaveLength(1);
		expect(await subject.listChannelSchedules()).toHaveLength(1);
	});

	it('suffixes generated template names and leaves no partial bundle on conflict', async () => {
		const subject = repository();
		subject.createQuickChannelSetup(await fixture(subject, '1'), 5_000);
		const second = subject.createQuickChannelSetup(await fixture(subject, '2'), 5_000);
		expect(second.template.name).toBe('Movie Channel Daily (2)');

		const conflicting = await fixture(subject, '3');
		conflicting.programName = second.program.name;
		expect(() => subject.createQuickChannelSetup(conflicting, 5_000)).toThrow(
			'That program name is already in use',
		);
		expect(await subject.listPrograms()).toHaveLength(2);
		expect(await subject.listScheduleTemplates()).toHaveLength(2);
		expect(await subject.listChannels()).toHaveLength(2);
		expect(await subject.listChannelSchedules()).toHaveLength(2);
	});

	it('rejects an incompatible library and missing explicit media', async () => {
		const subject = repository();
		const request = await fixture(subject);
		expect(() => subject.createQuickChannelSetup({ ...request, scenario: 'shows' }, 5_000))
			.toThrow('The library is not compatible with this scenario');
		expect(() => subject.createQuickChannelSetup({
			...request,
			source: {
				type: 'collection',
				itemIds: ['00000000-0000-4000-8000-000000000009'],
			},
		}, 5_000)).toThrow('Every selected item must be compatible media');
		expect(await subject.listPrograms()).toHaveLength(0);
	});
});
