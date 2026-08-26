import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { channelCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository, type TimelineCommit } from '@server/repository/index.js';

const databases: Array<ReturnType<typeof createDatabase>> = [];

afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close();
	}
});

describe('timeline failure persistence', () => {
	it('surfaces a failure before the first commit and replaces it after a successful commit', async () => {
		const database = createDatabase(':memory:', path.resolve('drizzle'));
		databases.push(database);
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({
			number: '40.1',
			name: 'Test channel',
		}));
		const failedAt = '2026-08-24T12:00:00Z';

		repository.markTimelineFailed(channel.id, 'Media duration is unavailable', failedAt);

		expect(await repository.listTimelineMaterializationStatuses()).toEqual([
			expect.objectContaining({
				channelId: channel.id,
				health: 'failed',
				windowStart: null,
				windowEnd: null,
				committedAt: null,
				lastError: 'Media duration is unavailable',
			}),
		]);
		expect(await repository.getTimelineMaterialization(channel.id)).toBeNull();

		const commit: TimelineCommit = {
			channelId: channel.id,
			windowStart: '2026-08-24T07:00:00Z',
			windowEnd: '2026-08-25T07:00:00Z',
			replaceFrom: '2026-08-24T07:00:00Z',
			continuationAt: '2026-08-25T07:00:00Z',
			inputFingerprint: 'healthy-fingerprint',
			baseState: [],
			finalState: [],
			segments: [],
			issues: [],
			committedAt: '2026-08-24T12:01:00Z',
		};
		repository.commitMaterializedTimeline(commit);

		expect(await repository.getTimelineMaterialization(channel.id)).toMatchObject({
			health: 'ready',
			windowStart: commit.windowStart,
			windowEnd: commit.windowEnd,
			lastError: null,
		});
	});
});
