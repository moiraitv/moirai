import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { channelCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import type { TimelineContinuation } from '@server/scheduling/continuation.js';

it('persists an active slot checkpoint through the repository and a database restart', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-continuation-'));
	const databasePath = path.join(root, 'test.sqlite');
	let database: ReturnType<typeof createDatabase> | undefined = createDatabase(databasePath, path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Checkpoint' }));
		const start = '2026-09-02T23:40:00Z';
		const finish = '2026-09-03T00:20:00Z';
		const continuation: TimelineContinuation = {
			at: finish, date: '2026-09-03', templateId: randomUUID(), slotId: randomUUID(), scheduleLayerId: null,
			intervalStart: '2026-09-03T00:00:00Z', intervalEnd: '2026-09-03T01:00:00Z',
			boundaryOrigin: 'template', phase: 'primary', hadPrimary: true, boundaryRejection: null,
		};
		repository.commitMaterializedTimeline({
			channelId: channel.id, windowStart: start, windowEnd: finish, replaceFrom: start, continuationAt: finish,
			inputFingerprint: 'fixture', baseState: [], finalState: [], issues: [], committedAt: start,
			segments: [{
				segment: {
					id: randomUUID(), channelId: channel.id, templateId: continuation.templateId, slotId: continuation.slotId,
					scheduleLayerId: null, programId: null, mediaItemId: null, role: 'primary', title: 'Committed item',
					playbackPath: null, playbackParts: [], start, finish, sourceStartSeconds: 0, sourceFinishSeconds: 2400, truncated: false,
				},
				mediaSnapshot: null, stateDelta: [], continuation,
			}],
		});
		database.close();
		database = undefined;
		database = createDatabase(databasePath, path.resolve('drizzle'));
		const restored = await new Repository(database.db).listMaterializedTimelineSegments(start, finish, channel.id);
		expect(restored[0]?.continuation).toEqual(continuation);
		expect(restored[0]?.segment).not.toHaveProperty('continuation');
	}
	finally {
		database?.close();
		await rm(root, { recursive: true, force: true });
	}
});
