import path from 'node:path';
import { catalogProgramItemQuerySchema } from '@moirai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '@server/db/index.js';
import { Repository, type DiscoveredGroup, type DiscoveredItem } from '@server/repository/index.js';
import { withCatalogSearchDefer } from '@server/repository/catalog-search-sql.js';

const databases: Array<ReturnType<typeof createDatabase>> = [];

function movie(title: string, plot: string | null = null): DiscoveredItem {
	return {
		id: crypto.randomUUID(),
		aliasIds: [],
		groupId: null,
		stableKey: title,
		kind: 'movie',
		title,
		sortTitle: title,
		relativePath: `${title}.mkv`,
		playbackPath: `/media/${title}.mkv`,
		nfoRelativePath: null,
		plot,
		year: null,
		durationMilliseconds: 1_800_000,
		probeFingerprint: `probe:${title}`,
		probeStatus: 'complete',
		probeUpdatedAt: '2026-08-24T00:00:00Z',
		probeErrorCode: null,
		technicalMetadata: {},
		seasonNumber: null,
		episodeNumber: null,
		episodeEndNumber: null,
		edition: null,
		externalIds: [],
		trackNumber: null,
		discNumber: null,
		artists: [],
		multipartStatus: 'none',
		parts: [],
		subtitleTracks: [],
		metadataStatus: 'complete',
		metadata: {},
		artworkRelativePath: null,
		posterRelativePath: null,
		landscapeRelativePath: null,
		fanartRelativePath: null,
		fingerprint: `metadata:${title}`,
		fileModifiedAt: '2026-08-23T00:00:00Z',
		titleBucket: title.slice(0, 1).toUpperCase(),
		genres: [],
		people: [],
	};
}

function show(id: string, title: string): DiscoveredGroup {
	return {
		id,
		stableKey: `show:${title}`,
		sourceKey: `show:${title}`,
		parentId: null,
		kind: 'show',
		title,
		sortTitle: title,
		year: null,
		plot: null,
		metadata: {},
		artworkRelativePath: null,
		posterRelativePath: null,
		landscapeRelativePath: null,
		fanartRelativePath: null,
	};
}

function season(id: string, parentId: string): DiscoveredGroup {
	return {
		id,
		stableKey: `season:${id}`,
		sourceKey: `season:${id}`,
		parentId,
		kind: 'season',
		title: 'Season 1',
		sortTitle: '00001',
		year: null,
		plot: null,
		metadata: { seasonNumber: 1 },
		artworkRelativePath: null,
		posterRelativePath: null,
		landscapeRelativePath: null,
		fanartRelativePath: null,
	};
}

function episode(groupId: string, title: string): DiscoveredItem {
	return {
		...movie(title),
		groupId,
		kind: 'episode',
		relativePath: `${title}.mkv`,
		playbackPath: `/media/${title}.mkv`,
	};
}

afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close();
	}
});

describe('catalog search persist', () => {
	it('stores item counts and rebuilds FTS once per scan without live COUNT joins', async () => {
		const database = createDatabase(':memory:', path.resolve('drizzle'));
		databases.push(database);
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/movies', playbackRoot: '/media' },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const alpha = movie('Alpha', 'Unstable frontier');
		const beta = movie('Beta');
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			[],
			[alpha, beta],
			[],
			true,
		);

		expect(await repository.getLibrary(library.id)).toMatchObject({ itemCount: 2 });
		expect(await repository.listLibraries()).toMatchObject([{ itemCount: 2 }]);
		expect(database.sqlite.prepare(
			'SELECT count(*) AS count FROM catalog_search WHERE library_id = ?',
		).get(library.id)).toEqual({ count: 2 });
		expect((await repository.browseMedia(library.id, {
			parentId: null,
			page: 1,
			pageSize: 10,
			sort: 'title',
			direction: 'asc',
			search: 'frontier',
			name: '',
			releaseYearFrom: null,
			releaseYearTo: null,
			minimumDurationSeconds: null,
			maximumDurationSeconds: null,
			minimumRating: null,
			minimumUserRating: null,
			addedFrom: null,
			addedBefore: null,
			genres: [],
			excludedGenres: [],
			genreMatch: 'any',
			actor: '',
			director: '',
		})).items.map((entry) => entry.id)).toEqual([alpha.id]);

		database.sqlite.prepare('DELETE FROM media_items').run();
		expect(await repository.getLibrary(library.id)).toMatchObject({ itemCount: 2 });
		expect(await repository.listLibraries()).toMatchObject([{ itemCount: 2 }]);
	});

	it('skips FTS rebuilds for artwork-only writes and while catalog persist is deferred', async () => {
		const database = createDatabase(':memory:', path.resolve('drizzle'));
		databases.push(database);
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/movies', playbackRoot: '/media' },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const item = movie('Alpha');
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			[],
			[item],
			[],
			true,
		);

		const body = (): string => (database.sqlite.prepare(
			'SELECT body FROM catalog_search WHERE entity_id = ? AND entity_kind = ?',
		).get(item.id, 'item') as { body: string }).body;
		const original = body();

		database.sqlite.prepare(
			'UPDATE media_items SET artwork_relative_path = ? WHERE id = ?',
		).run('poster.jpg', item.id);
		expect(body()).toBe(original);

		database.sqlite.prepare('UPDATE media_items SET title = ? WHERE id = ?').run('Beta', item.id);
		expect(body()).toContain('Beta');

		withCatalogSearchDefer(database.sqlite, () => {
			database.sqlite.prepare('UPDATE media_items SET title = ? WHERE id = ?').run('Gamma', item.id);
		});
		expect(body()).toContain('Beta');
		expect(body()).not.toContain('Gamma');

		database.sqlite.prepare('UPDATE media_items SET title = ? WHERE id = ?').run('Delta', item.id);
		expect(body()).toContain('Delta');
	});

	it('reindexes child items only when a group title changes', async () => {
		const database = createDatabase(':memory:', path.resolve('drizzle'));
		databases.push(database);
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Shows',
			typeKey: 'shows',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/shows', playbackRoot: '/media' },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const showId = crypto.randomUUID();
		const seasonId = crypto.randomUUID();
		const item = episode(seasonId, 'Pilot');
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			[show(showId, 'Example'), season(seasonId, showId)],
			[item],
			[],
			true,
		);

		const body = (): string => (database.sqlite.prepare(
			'SELECT body FROM catalog_search WHERE entity_id = ? AND entity_kind = ?',
		).get(item.id, 'item') as { body: string }).body;
		expect(body()).toContain('Example');

		database.sqlite.prepare(
			'UPDATE media_groups SET plot = ?, artwork_relative_path = ? WHERE id = ?',
		).run('New plot', 'fanart.jpg', showId);
		expect(body()).toContain('Example');
		expect(body()).not.toContain('New plot');

		database.sqlite.prepare('UPDATE media_groups SET title = ? WHERE id = ?').run('Renamed', showId);
		expect(body()).toContain('Renamed');
		expect(body()).not.toContain('Example');
	});
});


it('filters exact playback durations consistently in catalog counts and recursive selection', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	const repository = new Repository(database.db);
	const library = await repository.createLibrary({ name: 'Duration', typeKey: 'shows', sourceType: 'on-disk', sourceConfig: { scanRoot: '/shows', playbackRoot: '/media' }, scanIntervalMinutes: 15, watcherEnabled: false, enabled: true });
	const group = show(crypto.randomUUID(), 'Show');
	const items = [59_999, 60_000, 60_001, null].map((durationMilliseconds, index) => ({ ...episode(group.id, `Episode ${index}`), durationMilliseconds }));
	await repository.reconcileScan(await repository.beginScan(library.id, 'initial'), [group], items, [], true);
	for (const [bounds, expected] of [
		[{ minimumDurationSeconds: 60, maximumDurationSeconds: 60 }, [items[1]!.id]],
		[{ minimumDurationSeconds: 60 }, [items[1]!.id, items[2]!.id]],
		[{ maximumDurationSeconds: 60 }, [items[0]!.id, items[1]!.id]],
		[{ minimumDurationSeconds: 0 }, items.slice(0, 3).map(item => item.id)],
	] as const) {
		const query = catalogProgramItemQuerySchema.parse({ ...bounds });
		const result = await repository.browseMedia(library.id, { ...query, page: 1, pageSize: 100 });
		expect(result.items.map(item => item.id)).toEqual(expected);
		expect(result.pagination.totalEntries).toBe(expected.length);
		const selection = repository.resolveProgramItemSelection(library.id, { ...query, parentId: group.id });
		expect(selection.itemIds).toEqual(expected);
		expect(selection.matchedItemCount).toBe(expected.length);
	}
});
