import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { programContentBrowseRequestSchema, type ProgramContentSource } from '@moirai/shared';
import { mediaSourcePickerResultSchema } from '@moirai/shared/api-contracts';
import { mediaGroups, mediaItems, mediaItemAliases } from '@server/db/schema.js';
import { schedulingRead } from '@server/scheduling/read-jobs.js';
import { fixture } from '../semantic/fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

async function setup() {
	const f = await fixture(5);
	cleanups.push(() => f.close());
	return f;
}

async function browse(f: Awaited<ReturnType<typeof setup>>, source: ProgramContentSource, parentId?: string, page = 1, pageSize = 20) {
	const result = await schedulingRead(f.repository, { kind: 'program-content',
		input: programContentBrowseRequestSchema.parse({ source, parentId, page, pageSize }) });
	return mediaSourcePickerResultSchema.parse(JSON.parse(result.body));
}

function hierarchy(f: Awaited<ReturnType<typeof setup>>, kinds: ['show' | 'artist', 'season' | 'album'] = ['show', 'season']) {
	const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
	const root = randomUUID();
	for (const [id, parentId, kind, title] of [
		[root, null, kinds[0], 'Root'], [first, root, kinds[1], 'First'],
		[second, root, kinds[1], 'Second'], [third, null, kinds[0], 'Other'],
	] as const) {
		f.database.db.insert(mediaGroups).values({ id, parentId, kind, title, libraryId: f.library.id, stableKey: id, sortTitle: title, metadata: {} }).run();
	}
	for (const [index, groupId] of [first, first, second, third, third].entries()) {
		f.database.db.update(mediaItems).set({ groupId }).where(eq(mediaItems.id, f.ids[index]!)).run();
	}
	f.repository.invalidateSchedulingCatalog();
	return { root, first, second, third };
}

it('uses query filters, exclusions and limits before paging, retaining unavailable indexed items without writes', async () => {
	const f = await setup();
	f.database.db.update(mediaItems).set({ availability: 'unconfirmed' }).where(eq(mediaItems.id, f.ids[1]!)).run();
	const source: Extract<ProgramContentSource, { type: 'library-query' }> = { type: 'library-query', libraryId: f.library.id, kinds: [], genres: [],
		name: 'Film', sort: { type: 'name', direction: 'asc' }, itemLimit: 2, exclusions: { itemIds: [f.ids[0]!], groupIds: [] } };
	const before = await f.repository.listPrograms();
	const writes = f.database.sqlite.prepare('SELECT total_changes() AS count').get();
	const first = await browse(f, source, undefined, 1, 1);
	expect(first.entries.map(entry => entry.item?.id)).toEqual([f.ids[1]]);
	expect(first.entries[0]?.item?.availability).toBe('unconfirmed');
	expect(first.pagination).toMatchObject({ totalEntries: 2, totalPages: 2 });
	const second = await browse(f, source, undefined, 2, 1);
	expect(second.entries.map(entry => entry.item?.id)).toEqual([f.ids[2]]);
	const empty = await browse(f, { ...source, type: 'library-query', name: 'No match' });
	expect(empty.entries).toEqual([]);
	expect(empty.pagination).toMatchObject({ page: 1, totalEntries: 0, totalPages: 1 });
	expect(await f.repository.listPrograms()).toEqual(before);
	expect(f.database.sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(writes);
});

it.each([['show', 'season'], ['artist', 'album']] as const)('projects selected items through %s/%s while hiding unselected siblings', async (rootKind, childKind) => {
	const f = await setup();
	const groups = hierarchy(f, [rootKind, childKind]);
	const ids = [f.ids[2]!, f.ids[0]!];
	const source: ProgramContentSource = { type: 'collection', libraryId: f.library.id, itemIds: ids, sort: { type: 'manual', itemIds: ids } };
	expect((await browse(f, source)).entries.map(entry => entry.group?.id)).toEqual([groups.root]);
	expect((await browse(f, source, groups.root)).entries.map(entry => entry.group?.id)).toEqual([groups.second, groups.first]);
	expect((await browse(f, source, groups.first)).entries.map(entry => entry.item?.id)).toEqual([f.ids[0]]);
	expect((await browse(f, source, groups.third)).entries).toEqual([]);
	const excluded = { ...source, exclusions: { itemIds: [], groupIds: [groups.first] } };
	expect((await browse(f, excluded, groups.root)).entries.map(entry => entry.group?.id)).toEqual([groups.second]);
	expect((await browse(f, excluded, groups.first)).entries).toEqual([]);
});

it('deduplicates overlapping selected groups, removes excluded descendants and clamps pages after removals', async () => {
	const f = await setup();
	const groups = hierarchy(f);
	const source: ProgramContentSource = { type: 'group-collection', libraryId: f.library.id,
		groupIds: [groups.root, groups.first], exclusions: { itemIds: [f.ids[0]!], groupIds: [groups.second] } };
	expect((await browse(f, source)).entries.map(entry => entry.group?.id)).toEqual([groups.root]);
	const result = await browse(f, source, groups.first, 20, 1);
	expect(result.entries.map(entry => entry.item?.id)).toEqual([f.ids[1]]);
	expect(result.pagination).toMatchObject({ page: 1, totalEntries: 1, totalPages: 1 });
});

it('resolves canonical aliases, collapses equivalent inclusions, omits missing references and restores membership', async () => {
	const f = await setup();
	const alias = randomUUID();
	f.database.db.insert(mediaItemAliases).values({ aliasId: alias, itemId: f.ids[0]!, libraryId: f.library.id }).run();
	const ids = [alias, f.ids[0]!, randomUUID(), f.ids[1]!];
	const source: ProgramContentSource = { type: 'collection', libraryId: f.library.id, itemIds: ids, sort: { type: 'manual', itemIds: ids } };
	expect((await browse(f, source)).entries.map(entry => entry.item?.id)).toEqual(f.ids.slice(0, 2));
	expect((await browse(f, { ...source, exclusions: { itemIds: [alias], groupIds: [] } })).entries.map(entry => entry.item?.id)).toEqual([f.ids[1]]);
	expect((await browse(f, source)).entries.map(entry => entry.item?.id)).toEqual(f.ids.slice(0, 2));
});

it('preserves AI indexed-date ordering independently of selected-item insertion order', async () => {
	const f = await setup();
	for (const [index, date] of ['2026-10-03', '2026-10-01', '2026-10-02'].entries()) {
		f.database.db.update(mediaItems).set({ dateAddedAt: `${date}T00:00:00Z` }).where(eq(mediaItems.id, f.ids[index]!)).run();
	}
	const source: ProgramContentSource = { type: 'ai', libraryId: f.library.id, itemIds: f.ids.slice(0, 3),
		prompt: 'Current content', sort: { type: 'date-added', direction: 'asc' } };
	expect((await browse(f, source)).entries.map(entry => entry.item?.id)).toEqual([f.ids[1], f.ids[2], f.ids[0]]);
});

it('rejects invalid or unsupported sources and missing libraries, and ignores unknown parents', async () => {
	const f = await setup();
	expect(programContentBrowseRequestSchema.safeParse({ source: { type: 'item', itemId: f.ids[0] } }).success).toBe(false);
	expect(programContentBrowseRequestSchema.safeParse({ source: { type: 'collection', libraryId: f.library.id, itemIds: [f.ids[0], f.ids[0]] } }).success).toBe(false);
	expect(programContentBrowseRequestSchema.safeParse({ source: { type: 'collection', libraryId: f.library.id, itemIds: f.ids,
		sort: { type: 'manual', itemIds: [f.ids[0]] } } }).success).toBe(false);
	const source: ProgramContentSource = { type: 'collection', libraryId: f.library.id, itemIds: f.ids, sort: { type: 'date-added', direction: 'asc' } };
	expect((await browse(f, source, randomUUID())).entries).toEqual([]);
	await expect(browse(f, { ...source, libraryId: randomUUID() })).rejects.toMatchObject({ statusCode: 404 });
});
