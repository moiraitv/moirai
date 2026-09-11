import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { programConfigSchema, type SchedulingProgram } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { schedulingPrograms } from '@server/db/schema.js';
import { Repository } from '@server/repository/index.js';

const databases: Array<ReturnType<typeof createDatabase>> = [];
const libraryId = randomUUID();
const timestamp = '2026-09-11T00:00:00.000Z';

afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close();
	}
});

function fixture(count = 0) {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	database.sqlite.prepare(`INSERT INTO libraries (id, name, type_key, source_type, source_config)
		VALUES (?, 'Large library', 'movies', 'on-disk', '{"scanRoot":"/media"}')`).run(libraryId);
	if (count > 0) {
		database.sqlite.prepare(`WITH RECURSIVE numbers(n) AS (
			SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < ?
		) INSERT INTO media_items (id, library_id, stable_key, kind, title, sort_title,
			relative_path, playback_path, metadata_status, metadata, fingerprint, duration_milliseconds)
		SELECT 'item-'||n, ?, 'item-'||n, 'movie', 'Movie '||n, 'Movie '||n,
			'item-'||n, '/media/item-'||n, 'complete', '{}', 'fingerprint', 60000 FROM numbers`).run(count, libraryId);
	}
	return { database, repository: new Repository(database.db) };
}

function program(ids: string[]): SchedulingProgram {
	return {
		id: randomUUID(), name: randomUUID(), createdAt: timestamp, updatedAt: timestamp,
		config: programConfigSchema.parse({
			type: 'content', strategy: { type: 'sequential' },
			source: { type: 'collection', libraryId, itemIds: ids, sort: { type: 'date-added', direction: 'asc' } },
		}),
	};
}

it('loads aliases across multiple individually valid large collections', async () => {
	const { database, repository } = fixture(1);
	const ids = Array.from({ length: 40_000 }, () => randomUUID());
	database.sqlite.prepare('INSERT INTO media_item_aliases (alias_id, library_id, item_id) VALUES (?, ?, ?)')
		.run(ids[0], libraryId, 'item-1');
	const catalog = await repository.getSchedulingCatalog([program(ids.slice(0, 20_000)), program(ids.slice(20_000))]);
	expect(catalog.media.map(item => item.id)).toEqual(['item-1']);
	expect(catalog.mediaAliases?.[ids[0]!]).toBe('item-1');
});

it('returns capacity instead of failing while combining large existing and incoming collections', async () => {
	const { database, repository } = fixture();
	const current = program(Array.from({ length: 20_000 }, () => randomUUID()));
	await database.db.insert(schedulingPrograms).values({ ...current, nameKey: current.name });
	const result = repository.appendProgramItems(
		current.id, 
		libraryId,
		Array.from({ length: 20_000 }, () => randomUUID()), 
		undefined, 
		25_000,
	);
	expect(result).toMatchObject({ status: 'capacity', remainingItemCount: 5_000, addedItemCount: 20_000 });
	expect((await repository.getProgram(current.id))?.config).toEqual(current.config);
});

it('lists limited preferences after more than the SQLite parameter limit of distinct encounters', () => {
	const { database, repository } = fixture(33_000);
	database.sqlite.prepare(`INSERT INTO viewing_preference_events (id, media_item_id, points, encounter_type, occurred_at)
		SELECT id, id, 1, 'initial', ? FROM media_items`).run(timestamp);
	const result = repository.listViewingPreferences('2026-09-12T00:00:00.000Z', 5);
	expect(result).toHaveLength(5);
	expect(result.every(item => item.kind === 'item' && item.score > 0)).toBe(true);
});

it('persists all scan conflicts and rolls back replacement if a later batch fails', async () => {
	const { database, repository } = fixture();
	const conflicts = Array.from({ length: 4_200 }, (_, index) => ({
		conflictKey: String(index), kind: 'show-external-id' as const,
		provider: 'test', externalId: String(index), paths: ['a', 'b'], message: 'Duplicate identity',
	}));
	await repository.reconcileScan(await repository.beginScan(libraryId, 'initial'), [], [], [], true, undefined, conflicts);
	expect(database.sqlite.prepare('SELECT count(*) AS count FROM catalog_conflicts').get()).toEqual({ count: conflicts.length });
	const replacement = [...conflicts.map(conflict => ({ ...conflict, message: 'Replacement' })), conflicts[0]!];
	await expect(repository.reconcileScan(await repository.beginScan(libraryId, 'manual'), [], [], [], true, undefined, replacement)).rejects.toThrow(/UNIQUE constraint/);
	expect(database.sqlite.prepare('SELECT count(*) AS count FROM catalog_conflicts').get()).toEqual({ count: conflicts.length });
	expect(database.sqlite.prepare("SELECT message FROM catalog_conflicts WHERE conflict_key = '0'").get()).toEqual({ message: 'Duplicate identity' });
});

// This fixture must exceed 32,766 IDs; its real reconciliation writes 33,000 tombstones.
it('marks and heals a large missing library without losing its removal safeguards', async () => {
	const { database, repository } = fixture(33_000);
	const identity = { sourceType: 'on-disk' as const, sourceKey: '/media', details: { canonicalRoot: '/media', device: 'test', inode: 'test' } };
	await repository.reconcileScan(await repository.beginScan(libraryId, 'manual'), [], [], [], true, identity);
	expect(database.sqlite.prepare("SELECT count(*) AS count FROM media_items WHERE availability = 'unconfirmed'").get()).toEqual({ count: 33_000 });
	expect(database.sqlite.prepare('SELECT count(*) AS count FROM media_removal_tombstones').get()).toEqual({ count: 33_000 });
	const pending = await repository.getMissingItemPresenceBatch(libraryId);
	expect(pending).not.toBeNull();
	const result = await repository.applyMissingItemPresence(
		libraryId, 
		pending!.revision, 
		identity,
		Array.from({ length: 33_000 }, (_, index) => ({ itemId: 'item-' + (index + 1), status: 'present' as const })),
	);
	expect(result.applied).toBe(true);
	expect(database.sqlite.prepare("SELECT count(*) AS count FROM media_items WHERE availability = 'available'").get()).toEqual({ count: 33_000 });
	expect(database.sqlite.prepare('SELECT count(*) AS count FROM media_removal_tombstones').get()).toEqual({ count: 0 });
}, 20_000);
