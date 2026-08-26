import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { channelCreateSchema, type ScheduleTemplateCreate } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';

const databases: Array<ReturnType<typeof createDatabase>> = [];

/** Create a migrated in-memory repository for identity tests. */
function repository(): Repository {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	return new Repository(database.db);
}

/** Build the smallest valid daily template around one program. */
function template(name: string, programId: string, slotId = crypto.randomUUID()): ScheduleTemplateCreate {
	return {
		name,
		period: 'day',
		defaultFiller: null,
		slots: [{
			id: slotId,
			startSeconds: 0,
			programId,
			stateScope: 'persistent',
			startEligibility: { type: 'require-fit' },
			filler: { mode: 'inherit' },
		}],
		boundaries: [{
			id: crypto.randomUUID(),
			leftSlotId: slotId,
			rightSlotId: slotId,
			targetSeconds: 86_400,
			policy: 'hard',
			maxDriftSeconds: 0,
			fallback: 'reject-start',
		}],
	};
}

afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close();
	}
});

describe('resource identity', () => {
	it('rejects case and whitespace variants for named resources', async () => {
		const subject = repository();
		const library = await subject.createLibrary({
			name: 'Movie Library',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/media', playbackRoot: null },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		await expect(subject.createLibrary({
			name: ' movie   library ',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/other', playbackRoot: null },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		})).rejects.toThrow('already in use');
		const program = await subject.createProgram({
			name: 'Prime Time',
			config: {
				type: 'content',
				source: { type: 'library-query', libraryId: library.id, kinds: [], genres: [] },
				strategy: { type: 'sequential' },
			},
		});
		await expect(subject.createProgram({
			name: 'PRIME TIME',
			config: program.config,
		})).rejects.toThrow('already in use');
		await subject.createScheduleTemplate(template('Daily', program.id));
		await expect(subject.createScheduleTemplate(template(' daily ', program.id))).rejects.toThrow(
			'already in use',
		);
	});

	it('allows duplicate channel names but rejects case-folded channel numbers', async () => {
		const subject = repository();
		const first = channelCreateSchema.parse({ number: 'News-A', name: 'News' });
		const second = channelCreateSchema.parse({ number: 'News-B', name: 'News' });
		await subject.createChannel(first);
		await subject.createChannel(second);
		await expect(subject.createChannel(channelCreateSchema.parse({
			number: 'news-a',
			name: 'Different name',
		}))).rejects.toThrow('already in use');
		expect((await subject.listChannels()).map((channel) => channel.name)).toEqual(['News', 'News']);
	});

	it('rejects slot IDs already owned by another template', async () => {
		const subject = repository();
		const library = await subject.createLibrary({
			name: 'Movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/media', playbackRoot: null },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const program = await subject.createProgram({
			name: 'Movies',
			config: {
				type: 'content',
				source: { type: 'library-query', libraryId: library.id, kinds: [], genres: [] },
				strategy: { type: 'sequential' },
			},
		});
		const slotId = crypto.randomUUID();
		await subject.createScheduleTemplate(template('First', program.id, slotId));
		await expect(subject.createScheduleTemplate(template('Second', program.id, slotId))).rejects.toThrow(
			'already owned',
		);
	});

	it('returns persisted source conflicts through the bounded status report', async () => {
		const subject = repository();
		const library = await subject.createLibrary({
			name: 'Shows',
			typeKey: 'shows',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/shows', playbackRoot: null },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		await subject.reconcileScan(
			await subject.beginScan(library.id, 'initial'),
			[],
			[],
			[],
			true,
			undefined,
			[{
				conflictKey: 'show-external-id:tmdb:42',
				kind: 'show-external-id',
				provider: 'tmdb',
				externalId: '42',
				paths: ['Alpha', 'Beta'],
				message: 'tmdb ID 42 is present in multiple show folders.',
			}],
		);

		expect(await subject.listDataConflicts()).toMatchObject({
			truncated: false,
			conflicts: [{
				kind: 'show-external-id',
				libraryId: library.id,
				paths: ['Alpha', 'Beta'],
			}],
		});
	});
});
