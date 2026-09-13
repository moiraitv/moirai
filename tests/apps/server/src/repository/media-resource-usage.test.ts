import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatabase } from '@server/db/index.js';
import { libraries, mediaItems, mediaGroups, mediaItemAliases, mediaItemGenres, schedulingPrograms, channels, scheduleTemplates, channelSchedules, timelineMaterializations, materializedTimelineSegments } from '@server/db/schema.js';
import { mediaAirings } from '@server/repository/media-airings.js';
import { mediaResourceUsage } from '@server/repository/media-resource-usage.js';
import { SchedulingRepository } from '@server/repository/scheduling.js';
import { programConfigSchema } from '@moirai/shared';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));
function fixture() {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	const { db } = database;
	const libraryId = randomUUID();
	db.insert(libraries).values({ id: libraryId, name: 'Movies', typeKey: 'movies', sourceType: 'local', sourceConfig: { scanRoot: '/media', playbackRoot: null } }).run();
	const addItem = (title: string, groupId: string | null = null) => {
		const id = randomUUID();
		db.insert(mediaItems).values({ id, libraryId, groupId, stableKey: id, kind: 'movie', title, sortTitle: title,
			relativePath: id, playbackPath: `/media/${id}`, metadataStatus: 'complete', metadata: { rating: 8, actors: [{ name: 'Alice Example' }] },
			fingerprint: id, dateAddedAt: '2026-01-01', durationMilliseconds: 60000 }).run();
		return id;
	};
	const addProgram = (name: string, source: unknown) => {
		const id = randomUUID();
		db.insert(schedulingPrograms).values({ id, name, config: programConfigSchema.parse({ type: 'content', source, strategy: { type: 'sequential' } }) }).run();
		return id;
	};
	const scheduling = new SchedulingRepository(db);
	return { ...database, libraryId, addItem, addProgram, scheduling,
		usage: (id: string, page = 1, size = 50) => mediaResourceUsage(db, scheduling, id, page, size) };
}

it('finds selected items, aliases and group ancestry without loading a dynamic catalog', async () => {
	const { db, libraryId, addItem, addProgram, usage, scheduling } = fixture();
	const parent = randomUUID(), child = randomUUID(), alias = randomUUID();
	for (const [id, parentId] of [[parent, null], [child, parent]] as const) {
		db.insert(mediaGroups).values({ id, parentId, libraryId, stableKey: id, kind: 'show', title: id, sortTitle: id, metadata: {} }).run();
	}
	const item = addItem('Target', child);
	db.insert(mediaItemAliases).values({ aliasId: alias, itemId: item, libraryId }).run();
	addProgram('Exact', { type: 'item', itemId: alias });
	addProgram('Collection', { type: 'collection', libraryId, itemIds: [item, alias] });
	addProgram('Ancestor', { type: 'group', groupId: parent });
	addProgram('Direct group', { type: 'group', groupId: child, includeDescendants: false });
	addProgram('Groups', { type: 'group-collection', libraryId, groupIds: [parent, child] });
	addProgram('Not recursive', { type: 'group', groupId: parent, includeDescendants: false });
	addProgram('Other library', { type: 'collection', libraryId: randomUUID(), itemIds: [item] });
	const load = vi.spyOn(scheduling, 'getSchedulingCatalog');
	const result = await usage(item);
	expect(result?.items.map(owner => owner.name)).toEqual(['Ancestor', 'Collection', 'Direct group', 'Exact', 'Groups']);
	expect(result?.items.every(owner => owner.referenceCount === 1)).toBe(true);
	expect(load).not.toHaveBeenCalled();
	expect(await usage(randomUUID())).toBeNull();
});

it('uses scheduler filters and query limits with a single shared catalog, retaining unavailable membership', async () => {
	const { db, sqlite, libraryId, addItem, addProgram, usage, scheduling } = fixture();
	addItem('Alpha');
	const item = addItem('Zulu');
	db.insert(mediaItemGenres).values({ itemId: item, libraryId, genreKey: 'drama', genreName: 'Drama' }).run();
	const source = { type: 'library-query', libraryId };
	addProgram('All', source);
	addProgram('Filtered', { ...source, genres: ['drama'], minimumRating: 7, actor: 'alice', name: 'zul' });
	addProgram('Excluded genre', { ...source, excludedGenres: ['drama'] });
	addProgram('Wrong name', { ...source, name: 'Alpha' });
	addProgram('Outside limit', { ...source, itemLimit: 1 });
	addProgram('Inside limit', { ...source, itemLimit: 1, sort: { type: 'name', direction: 'desc' } });
	addProgram('Other library', { ...source, libraryId: randomUUID() });
	const load = vi.spyOn(scheduling, 'getSchedulingCatalog');
	const prepare = vi.spyOn(sqlite, 'prepare');
	expect((await usage(item))?.items.map(owner => owner.name)).toEqual(['All', 'Filtered', 'Inside limit']);
	expect(load).toHaveBeenCalledTimes(1);
	const reads = prepare.mock.calls.filter(([query]) => /SELECT/i.test(query)).length;
	for (let index = 0; index < 60; index++) {
		addProgram(`Query ${index.toString().padStart(2, '0')}`, source);
	}
	scheduling.invalidateSchedulingCatalog();
	prepare.mockClear();
	const result = await usage(item, 2, 50);
	expect(result?.total).toBe(63);
	expect(result?.items).toHaveLength(13);
	expect(prepare.mock.calls.filter(([query]) => /SELECT/i.test(query))).toHaveLength(reads);
	prepare.mockRestore();
	// Missing files remain authored members rather than disappearing from usage inspection.
	db.run(`UPDATE media_items SET availability = 'missing' WHERE id = '${item}'`);
	scheduling.invalidateSchedulingCatalog();
	expect((await usage(item))?.total).toBe(63);
});


it('paginates current and upcoming committed showings without realizing missing schedules', () => {
	const { db, libraryId, addItem } = fixture();
	const item = addItem('Scheduled'), other = addItem('Other'), alias = randomUUID();
	db.insert(mediaItemAliases).values({ aliasId: alias, itemId: item, libraryId }).run();
	const channel = randomUUID(), template = randomUUID();
	db.insert(channels).values({ id: channel, number: '4', name: 'Cinema', config: {} as never }).run();
	db.insert(scheduleTemplates).values({ id: template, name: 'Day' }).run();
	db.insert(channelSchedules).values({ channelId: channel, defaultTemplateId: template, config: {} as never }).run();
	const now = Date.now();
	const at = (minutes: number) => new Date(now + minutes * 60000).toISOString();
	db.insert(timelineMaterializations).values({ channelId: channel, status: 'pending', windowStart: at(-60), windowEnd: at(1440), continuationAt: at(1440), inputFingerprint: 'committed', baseState: [], issues: [], committedAt: at(-60) }).run();
	const segment = (start: number, finish: number, mediaItemId = item) => {
		db.insert(materializedTimelineSegments).values({ id: randomUUID(), channelId: channel, templateId: template, slotId: randomUUID(), mediaItemId,
			role: 'primary', title: 'Scheduled', startsAt: at(start), finishesAt: at(finish), sourceStartSeconds: 0, truncated: false, stateDelta: [] }).run();
	};
	segment(-10, 10, alias);
	segment(-50, -20);
	segment(10, 20, other);
	segment(1500, 1510);
	for (let index = 0; index < 24; index++) {
		segment(20 + index * 10, 30 + index * 10);
	}
	const first = mediaAirings(db, item, 1, 20)!;
	expect(first.total).toBe(25);
	expect(first.items).toHaveLength(20);
	expect(first.items[0]).toMatchObject({ channelId: channel, channelName: 'Cinema', channelNumber: '4', startsAt: at(-10), finishesAt: at(10) });
	expect(mediaAirings(db, item, 2, 20)?.items).toHaveLength(5);
	expect(mediaAirings(db, item, 3, 20)?.items).toEqual([]);
	expect(mediaAirings(db, randomUUID(), 1, 20)).toBeNull();
	db.delete(timelineMaterializations).run();
	expect(mediaAirings(db, item, 1, 20)).toEqual({ items: [], total: 0 });
	expect(db.select().from(timelineMaterializations).all()).toEqual([]);
});
