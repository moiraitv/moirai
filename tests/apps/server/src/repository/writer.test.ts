import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { DatabaseWriter, DATABASE_WRITE_QUEUE_LIMIT, DatabaseWriteQueueFullError, writerRepository } from '@server/repository/writer.js';
import { ResourceIdentityConflictError } from '@server/repository/resource-identity.js';
import { channelCreateSchema, catalogProgramItemQuerySchema, quickChannelSetupCreateSchema, libraryCreateSchema } from '@moirai/shared';
import { discoverOnDisk } from '@server/scanner/on-disk.js';
import { StaleSemanticDecisionError } from '@server/repository/semantic.js';
import type { TimelineCommit } from '@server/repository/contracts.js';
import type { WriteCommand } from '@server/repository/write-commands.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

async function fixture(setup?: (database: ReturnType<typeof createDatabase>) => void) {
	const directory = await mkdtemp(path.join(tmpdir(), 'moirai-writer-test-'));
	const database = createDatabase(path.join(directory, 'database.sqlite'), path.resolve('drizzle'));
	setup?.(database);
	const writer = new DatabaseWriter(database.sqlite.name);
	database.sqlite.pragma('query_only = ON');
	const repository = writerRepository(new Repository(database.db, true), writer);
	cleanups.push(async () => {
		await writer.close();
		database.close();
		await rm(directory, { recursive: true, force: true });
	});
	return { directory, database, writer, repository };
}

it('commits off-thread before read-only callers observe a result and preserves domain errors', async () => {
	const { database, repository } = await fixture();
	const input = libraryCreateSchema.parse({ name: 'Movies', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: '/media/movies' } });
	const library = await repository.createLibrary(input);
	expect((await repository.getLibrary(library.id))?.name).toBe('Movies');
	expect(() => database.sqlite.prepare("UPDATE libraries SET name='unsafe'").run()).toThrow(/readonly/iu);
	await expect(repository.createLibrary({ ...input, name: 'movies' })).rejects.toBeInstanceOf(ResourceIdentityConflictError);
	expect(await repository.listLibraries()).toHaveLength(1);
});

it('bounds accepted writes and drains accepted FIFO commands on shutdown', async () => {
	const { writer, repository } = await fixture();
	const id = '00000000-0000-4000-8000-000000000001';
	const jobs = Array.from({ length: DATABASE_WRITE_QUEUE_LIMIT + 2 }, () =>
		writer.execute({ domain: 'root', method: 'markChangeDetected', args: [id] }));
	const result = Promise.allSettled(jobs);
	await writer.close();
	const completed = await result;
	expect(completed.filter(entry => entry.status === 'fulfilled')).toHaveLength(DATABASE_WRITE_QUEUE_LIMIT + 1);
	const rejected = completed.find(entry => entry.status === 'rejected');
	expect(rejected && rejected.status === 'rejected' && rejected.reason).toBeInstanceOf(DatabaseWriteQueueFullError);
	await expect(repository.markChangeDetected(id)).rejects.toThrow(/closing/iu);
});

it('backpressures background producers and rejects unlisted commands without killing the writer', async () => {
	const { writer } = await fixture();
	const id = '00000000-0000-4000-8000-000000000001';
	const command = { domain: 'root', method: 'markChangeDetected', args: [id] } satisfies WriteCommand;
	await Promise.all(Array.from({ length: DATABASE_WRITE_QUEUE_LIMIT + 5 }, () => writer.execute(command, true)));
	await expect(writer.execute({ domain: 'root', method: 'checkDatabase', args: [] } as unknown as WriteCommand)).rejects.toThrow('Unknown database write command');
	await expect(writer.execute(command)).resolves.toBeUndefined();
});


it('preserves FIFO edits, snapshots accepted arguments, and observes scans only after reconciliation', async () => {
	const { directory, repository } = await fixture();
	const library = await repository.createLibrary(libraryCreateSchema.parse({ name: 'Movies', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: directory } }));
	await writeFile(path.join(directory, 'Test.mp4'), 'fixture');
	const discovery = await discoverOnDisk(library, { probeMedia: async () => ({ durationMilliseconds: 30_000, fileSizeBytes: 7, container: 'mp4', streams: [], resolution: null, tags: {} }) });
	const run = await repository.beginScan(library.id, 'initial');
	const reconciled = repository.reconcileScan(run, discovery.groups, discovery.items, discovery.issues, true);
	const edit = { name: 'Changed' };
	const first = repository.updateLibrary(library.id, edit);
	edit.name = 'Should not persist';
	const second = repository.updateLibrary(library.id, { name: 'Final' });
	const results = await Promise.all([reconciled, first, second]);
	expect(results[1]?.name).toBe('Changed');
	expect((await repository.getLibrary(library.id))?.name).toBe('Final');
	expect((await repository.listScans(library.id))[0]?.status).toBe('complete');
	expect((await repository.browseMedia(library.id, { ...catalogProgramItemQuerySchema.parse({}), page: 1, pageSize: 10, sort: 'title', direction: 'asc' })).items).toHaveLength(1);
	const cancelled = await repository.beginScan(library.id, 'manual');
	await repository.cancelScan(cancelled);
	expect((await repository.listScans(library.id))[0]?.status).toBe('cancelled');
});

it('rolls back an entire multi-resource transaction and continues processing later commands', async () => {
	const { database, repository } = await fixture(database => {
		database.sqlite.exec("CREATE TRIGGER reject_test_channel BEFORE INSERT ON channels WHEN NEW.number='999' BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
	});
	const library = await repository.createLibrary(libraryCreateSchema.parse({ name: 'Movies', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: '/media/movies' } }));
	const input = quickChannelSetupCreateSchema.parse({ scenario: 'movies', libraryId: library.id, programName: 'Rollback', source: { type: 'library-query', genres: [] }, strategy: { type: 'shuffle', seed: '' }, channel: { number: '999', name: 'Rollback' } });
	// Validation succeeds; the injected SQLite failure occurs after the Program insert.
	await expect(repository.createQuickChannelSetup(input, 100)).rejects.toThrow('test rollback');
	expect(await repository.listPrograms()).toEqual([]);
	expect(await repository.listChannels()).toEqual([]);
	expect(database.sqlite.prepare('SELECT count(*) AS total FROM channel_schedules').get()).toEqual({ total: 0 });
	await expect(repository.createQuickChannelSetup({ ...input, channel: { ...input.channel, number: '998' } }, 100)).resolves.toHaveProperty('channel.number', '998');
});

it('rejects queued commands after worker startup failure without replaying them', async () => {
	const writer = new DatabaseWriter(path.join(tmpdir(), 'nonexistent-moirai-writer', 'database.sqlite'));
	try {
		await expect(writer.execute({ domain: 'root', method: 'markChangeDetected', args: ['missing'] })).rejects.toThrow();
		expect(() => writer.checkReady()).toThrow();
		await expect(writer.execute({ domain: 'root', method: 'markChangeDetected', args: ['missing'] })).rejects.toThrow();
	}
	finally {
		await writer.close();
	}
});


it('rejects stale timeline commands and preserves the acknowledged authoritative revision', async () => {
	const { repository } = await fixture();
	const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Test' }));
	const commit: TimelineCommit = {
		channelId: channel.id, windowStart: '2026-10-01T00:00:00Z', windowEnd: '2026-10-05T00:00:00Z',
		replaceFrom: '2026-10-01T00:00:00Z', continuationAt: '2026-10-05T00:00:00Z', inputFingerprint: 'first',
		baseState: [], finalState: [], segments: [], issues: [], committedAt: '2026-10-01T12:00:00Z', expectedCommittedAt: null,
	};
	await repository.commitMaterializedTimeline(commit);
	await expect(repository.commitMaterializedTimeline({ ...commit, inputFingerprint: 'stale' })).rejects.toBeInstanceOf(StaleSemanticDecisionError);
	expect(await repository.getTimelineMaterialization(channel.id)).toMatchObject({ inputFingerprint: 'first', revision: 1 });
});
