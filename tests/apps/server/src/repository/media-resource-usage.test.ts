import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatabase } from '@server/db/index.js';
import { eq } from 'drizzle-orm';
import { libraries, mediaItems, mediaGroups, mediaItemAliases, mediaItemGenres, schedulingPrograms, channels, scheduleTemplates, channelSchedules, timelineMaterializations, materializedTimelineSegments } from '@server/db/schema.js';
import { mediaAirings } from '@server/repository/media-airings.js';
import { mediaResourceUsage } from '@server/repository/media-resource-usage.js';
import { SchedulingRepository } from '@server/repository/scheduling.js';
import { programConfigSchema } from '@moirai/shared';
import { schedulingProgramStatuses } from '@server/scheduling/status.js';
import { selectProgram, type SelectionContext } from '@server/scheduling/selection.js';

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

it('subtracts aliased items and overlapping group trees before query limits and reports fully excluded sources as empty', async () => {
	const { db, libraryId, addItem, usage, scheduling } = fixture();
	const group = (title: string, parentId: string | null = null) => {
		const id = randomUUID();
		db.insert(mediaGroups).values({ id, parentId, libraryId, stableKey: id, kind: parentId ? 'season' : 'show', title, sortTitle: title, metadata: {} }).run();
		return id;
	};
	const excludedShow = group('Excluded show');
	const season = group('Season 1', excludedShow);
	const differentShow = group('Unrelated show');
	const excludedEpisode = addItem('Alpha', season);
	const aliasedItem = addItem('Bravo');
	const eligible = addItem('Zulu', differentShow);
	const alias = randomUUID();
	db.insert(mediaItemAliases).values({ aliasId: alias, itemId: aliasedItem, libraryId }).run();
	const exclusions = { itemIds: [alias, alias], groupIds: [season, excludedShow] };
	const strategy = { type: 'sequential' } as const;
	const query = await scheduling.createProgram({ name: 'Query', config: { type: 'content', strategy,
		source: { type: 'library-query', libraryId, kinds: [], genres: [], itemLimit: 1, exclusions } } });
	const items = await scheduling.createProgram({ name: 'Items', config: { type: 'content', strategy,
		source: { type: 'collection', libraryId, itemIds: [excludedEpisode, aliasedItem], sort: { type: 'date-added', direction: 'asc' }, exclusions } } });
	const groups = await scheduling.createProgram({ name: 'Groups', config: { type: 'content', strategy,
		source: { type: 'group-collection', libraryId, groupIds: [excludedShow, differentShow], exclusions } } });
	const ai = await scheduling.createProgram({ name: 'AI', config: { type: 'content', strategy,
		source: { type: 'ai', libraryId, prompt: 'Library titles', itemIds: [excludedEpisode, aliasedItem, eligible], sort: { type: 'date-added', direction: 'asc' }, exclusions } } });
	expect((await scheduling.getProgram(query.id))?.config).toMatchObject({ source: { exclusions: { itemIds: [alias], groupIds: [...exclusions.groupIds].sort() } } });
	const laterEpisode = addItem('A new episode', season);
	const programs = [query, items, groups, ai];
	const catalog = await scheduling.getSchedulingCatalog(programs);
	const statuses = schedulingProgramStatuses(programs, catalog);
	expect(statuses.map(status => status.previewItems.map(item => item.id))).toEqual([[eligible], [], [eligible], [eligible]]);
	expect(statuses[1]).toMatchObject({ health: 'empty', indexedItemCount: 0 });
	const scoped = await scheduling.getSchedulingCatalog([items, { ...groups, config: { type: 'content', strategy,
		source: { type: 'group-collection', libraryId, groupIds: [differentShow] } } }]);
	expect(schedulingProgramStatuses([items], scoped)[0]).toMatchObject({ health: 'empty' });
	expect(scoped.media.map(item => item.id)).not.toContain(laterEpisode);
	expect((await usage(eligible))?.items.map(owner => owner.name)).toEqual(['AI', 'Groups', 'Query']);
	for (const id of [excludedEpisode, aliasedItem, laterEpisode]) {
		expect((await usage(id))?.total).toBe(0);
	}
});

it.each(['library-query', 'group-collection'] as const)('resumes a %s from a saved multipart cursor after an exclusion edit', async type => {
	const { db, libraryId, addItem, scheduling } = fixture();
	const groupId = randomUUID();
	db.insert(mediaGroups).values({ id: groupId, libraryId, stableKey: groupId, kind: 'show', title: 'Series', sortTitle: 'Series', metadata: {} }).run();
	const a = addItem('Alpha', groupId);
	const b = addItem('Bravo', groupId);
	const c = addItem('Charlie', groupId);
	addItem('Delta', groupId);
	const source = type === 'library-query' ? { type, libraryId, kinds: [], genres: [] } : { type, libraryId, groupIds: [groupId] };
	const strategy = { type: 'sequential' } as const;
	const program = await scheduling.createProgram({ name: 'Sequential', config: { type: 'content', source, strategy } });
	const context = async (): Promise<SelectionContext> => {
		const programs = await scheduling.listPrograms();
		const catalog = await scheduling.getSchedulingCatalog(programs);
		return { programs: new Map(programs.map(program => [program.id, program])), catalog,
			candidateCache: new Map(), blockedPrograms: new Set(), fitRejectionCount: 0, issues: [], issueKeys: new Set(), issueIndex: new Map(),
			boundaryOrigin: null, templateId: randomUUID(), scheduleLayerId: null, slotId: randomUUID(), now: '2026-01-01T00:00:00Z',
			viewingPreferences: { itemScores: {}, showScores: {} }, selectionStart: '2026-01-01T00:00:00Z', occupiedMedia: [] };
	};
	const original = await context();
	const key = `primary:cursor:${program.id}`;
	const first = selectProgram(program.id, key, new Map(), original)!;
	const second = selectProgram(program.id, key, first.state, original)!;
	expect([first.media.id, second.media.id]).toEqual([a, b]);

	const canonical = addItem('Bravo', groupId);
	const unrelatedAlias = randomUUID();
	db.insert(mediaItemAliases).values([{ aliasId: b, itemId: canonical, libraryId }, { aliasId: unrelatedAlias, itemId: c, libraryId }]).run();
	db.delete(mediaItems).where(eq(mediaItems.id, b)).run();
	scheduling.invalidateSchedulingCatalog();
	await scheduling.updateProgram(program.id, { config: { type: 'content', strategy, source: { ...source, exclusions: { itemIds: [a], groupIds: [] } } } });
	const overview = await context();
	expect(overview.catalog.mediaAliases?.[b]).toBeUndefined();
	const catalog = await scheduling.withSchedulingCursorAliases(overview.catalog, second.state.values());
	expect(catalog.mediaAliases?.[b]).toBe(canonical);
	expect(catalog.mediaAliases?.[unrelatedAlias]).toBeUndefined();
	expect(catalog.media).toBe(overview.catalog.media);
	expect(overview.catalog.mediaAliases?.[b]).toBeUndefined();
	expect(catalog.cacheKey).not.toBe(overview.catalog.cacheKey);
	const resumed = selectProgram(program.id, key, second.state, { ...overview, catalog });
	expect(resumed?.media.id).toBe(c);
});

it('rejects new exclusions from another library and preserves a previously saved reference after removal', async () => {
	const { db, libraryId, addItem, scheduling } = fixture();
	const otherLibraryId = randomUUID(), otherGroup = randomUUID(), otherItem = randomUUID();
	db.insert(libraries).values({ id: otherLibraryId, name: 'Other', typeKey: 'shows', sourceType: 'local', sourceConfig: { scanRoot: '/other', playbackRoot: null } }).run();
	db.insert(mediaGroups).values({ id: otherGroup, libraryId: otherLibraryId, stableKey: otherGroup, kind: 'show', title: 'Other', sortTitle: 'Other', metadata: {} }).run();
	db.insert(mediaItems).values({ id: otherItem, libraryId: otherLibraryId, stableKey: otherItem, kind: 'episode', title: 'Other', sortTitle: 'Other',
		relativePath: otherItem, playbackPath: '/other/episode', metadataStatus: 'complete', metadata: {}, fingerprint: otherItem, dateAddedAt: '2026-01-01' }).run();
	const item = addItem('Removed later');
	const config = programConfigSchema.parse({ type: 'content', strategy: { type: 'sequential' },
		source: { type: 'library-query', libraryId, exclusions: { itemIds: [item] } } });
	const program = await scheduling.createProgram({ name: 'Original', config });
	const withExclusions = (itemIds: string[], groupIds: string[]) => programConfigSchema.parse({ ...config,
		source: { type: 'library-query', libraryId, exclusions: { itemIds, groupIds } } });
	await expect(scheduling.updateProgram(program.id, { config: withExclusions([item, otherItem], []) })).rejects.toThrow(/excluded items/i);
	await expect(scheduling.updateProgram(program.id, { config: withExclusions([item], [otherGroup]) })).rejects.toThrow(/excluded groups/i);
	db.delete(mediaItems).where(eq(mediaItems.id, item)).run();
	await expect(scheduling.updateProgram(program.id, { name: 'Renamed', config })).resolves.toMatchObject({ name: 'Renamed', config });
	await expect(scheduling.updateProgram(program.id, { config: withExclusions([], []) })).resolves.toMatchObject({ name: 'Renamed' });
	await expect(scheduling.updateProgram(program.id, { config })).rejects.toThrow(/excluded items/i);
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

it('lists split primary airings once with full bounds while retaining individual filler showings', () => {
	const { db, libraryId, addItem } = fixture();
	const item = addItem('Movie'), alias = randomUUID();
	db.insert(mediaItemAliases).values({ aliasId: alias, itemId: item, libraryId }).run();
	const channel = randomUUID(), template = randomUUID();
	db.insert(channels).values({ id: channel, number: '4', name: 'Cinema', config: {} as never }).run();
	db.insert(scheduleTemplates).values({ id: template, name: 'Day' }).run();
	db.insert(channelSchedules).values({ channelId: channel, defaultTemplateId: template, config: {} as never }).run();
	const now = Date.now();
	const at = (minutes: number) => new Date(now + minutes * 60000).toISOString();
	db.insert(timelineMaterializations).values({ channelId: channel, status: 'pending', windowStart: at(-5), windowEnd: at(100),
		continuationAt: at(100), inputFingerprint: 'committed', baseState: [], issues: [], committedAt: at(-5) }).run();
	const addAiring = (start: number, finish: number) => {
		const anchor = randomUUID();
		const airing = { id: randomUUID(), primarySegmentId: anchor, start: at(start), finish: at(finish), truncated: false };
		for (const [id, role, from, to] of [[anchor, 'primary', start + 1, start + 4],
			[randomUUID(), 'filler', start + 4, start + 5], [randomUUID(), 'primary', start + 5, finish]] as const) {
			db.insert(materializedTimelineSegments).values({ id, channelId: channel, templateId: template, slotId: randomUUID(), mediaItemId: alias,
				role, title: 'Movie', startsAt: at(from), finishesAt: at(to), sourceStartSeconds: 0, truncated: false, stateDelta: [], airing }).run();
		}
		return anchor;
	};
	addAiring(-20, -10);
	const current = addAiring(-10, 10);
	const upcoming = addAiring(20, 40);
	const result = mediaAirings(db, item, 1, 2)!;
	expect(result.total).toBe(3);
	expect(result.items).toEqual([
		expect.objectContaining({ id: current, startsAt: at(-10), finishesAt: at(10) }),
		expect.objectContaining({ id: upcoming, startsAt: at(20), finishesAt: at(40) }),
	]);
	expect(mediaAirings(db, item, 2, 2)?.items).toEqual([
		expect.objectContaining({ startsAt: at(24), finishesAt: at(25) }),
	]);
});

it('compares current and upcoming airing bounds at integer millisecond precision', () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-08-23T00:00:00Z'));
	try {
		const { db, addItem } = fixture();
		const item = addItem('Subsecond showings');
		const channel = randomUUID(), template = randomUUID();
		db.insert(channels).values({ id: channel, number: '4', name: 'Cinema', config: {} as never }).run();
		db.insert(scheduleTemplates).values({ id: template, name: 'Day' }).run();
		db.insert(channelSchedules).values({ channelId: channel, defaultTemplateId: template, config: {} as never }).run();
		const start = '2026-08-23T00:00:00Z';
		const boundary = '2026-08-23T00:00:00.71Z';
		const finish = '2026-08-23T00:00:01.000Z';
		db.insert(timelineMaterializations).values({ channelId: channel, status: 'ready', windowStart: start, windowEnd: finish,
			continuationAt: finish, inputFingerprint: 'committed', baseState: [], issues: [], committedAt: start }).run();
		const current = randomUUID(), upcoming = randomUUID();
		for (const [id, from, to] of [[current, start, boundary], [upcoming, boundary, finish],
			[randomUUID(), '2026-08-23T00:00:01Z', '2026-08-23T00:00:02Z'],
			[randomUUID(), '2026-08-22T23:59:59Z', '2026-08-23T00:00:00.000Z']] as const) {
			db.insert(materializedTimelineSegments).values({
				id, channelId: channel, templateId: template, slotId: randomUUID(), mediaItemId: item,
				role: 'primary', title: 'Clip', startsAt: from, finishesAt: to, sourceStartSeconds: 0, truncated: false, stateDelta: [],
				...(id === current ? { airing: { id: randomUUID(), primarySegmentId: id, start: from, finish: to, truncated: false } } : {}),
			}).run();
		}
		expect(mediaAirings(db, item, 1, 20)).toMatchObject({ total: 2, items: [{ id: current }, { id: upcoming }] });
		vi.setSystemTime(new Date('2026-08-22T17:00:00.710-07:00'));
		expect(mediaAirings(db, item, 1, 20)).toMatchObject({ total: 1, items: [{ id: upcoming }] });
	}
	finally {
		vi.useRealTimers();
	}
});
