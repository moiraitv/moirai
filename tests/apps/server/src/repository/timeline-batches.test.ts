import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, it } from 'vitest';
import { channelCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository, type TimelineCommit } from '@server/repository/index.js';

function commit(channelId: string, count: number): TimelineCommit {
	const start = '2026-09-11T00:00:00Z';
	const finish = new Date(Date.parse(start) + count * 60_000).toISOString();
	return {
		channelId, windowStart: start, windowEnd: finish, replaceFrom: start, continuationAt: finish,
		inputFingerprint: randomUUID(), baseState: [], finalState: [], issues: [], committedAt: start,
		segments: Array.from({ length: count }, (_, index) => ({
			segment: {
				id: randomUUID(), channelId, templateId: 'template', slotId: 'slot', scheduleLayerId: null,
				programId: null, mediaItemId: null, role: 'dead-air', title: 'Gap', playbackPath: null,
				playbackParts: [], programAncestry: [], start: new Date(Date.parse(start) + index * 60_000).toISOString(),
				finish: new Date(Date.parse(start) + (index + 1) * 60_000).toISOString(),
				sourceStartSeconds: 0, sourceFinishSeconds: 60, truncated: false,
			},
			mediaSnapshot: null, stateDelta: [], continuation: null,
		})),
	};
}

it('commits a dense rolling timeline without exceeding SQLite statement parameters', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Dense' }));
		const input = commit(channel.id, 2_000);
		repository.markTimelineFailed(channel.id, 'too many SQL variables', input.committedAt);
		expect(() => repository.commitMaterializedTimeline(input)).not.toThrow();
		const rows = await repository.listMaterializedTimelineSegments(input.windowStart, input.windowEnd, channel.id);
		expect(rows.map(row => row.segment.id)).toEqual(input.segments.map(row => row.segment.id));
		expect(await repository.getTimelineMaterialization(channel.id)).toMatchObject({ health: 'ready', lastError: null, windowEnd: input.windowEnd });
	}
	finally {
		database.close();
	}
});

it('rolls back earlier batches and the prior deletion when a later batch fails', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Atomic' }));
		const original = commit(channel.id, 1);
		repository.commitMaterializedTimeline(original);
		const replacement = commit(channel.id, 2_000);
		replacement.segments.at(-1)!.segment.channelId = 'missing-channel';
		expect(() => repository.commitMaterializedTimeline(replacement)).toThrow(/FOREIGN KEY/);
		const rows = await repository.listMaterializedTimelineSegments(replacement.windowStart, replacement.windowEnd, channel.id);
		expect(rows.map(row => row.segment.id)).toEqual([original.segments[0]!.segment.id]);
		expect(await repository.getTimelineMaterialization(channel.id)).toMatchObject({ inputFingerprint: original.inputFingerprint, windowEnd: original.windowEnd });
	}
	finally {
		database.close();
	}
});

it('commits large selection-state sets without exceeding SQLite statement parameters', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Many cursors' }));
		const input = commit(channel.id, 1);
		input.finalState = Array.from({ length: 7_000 }, (_, index) => ({
			consumerKey: String(index).padStart(5, '0'),
			configFingerprint: 'configuration',
			value: { type: 'sequential', nextIndex: index, lastItemId: null },
			updatedAt: input.committedAt,
		}));

		repository.commitMaterializedTimeline(input);
		expect(await repository.getSelectionState(channel.id)).toEqual(input.finalState);
	}
	finally {
		database.close();
	}
});
