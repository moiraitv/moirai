import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	catalogProgramItemQuerySchema,
	MAX_LIBRARY_CONTENT_PREVIEW_ITEMS,
	PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD,
	REMOVAL_CONFIRMATION_INTERVAL_MINUTES,
	REMOVAL_CONFIRMATION_OBSERVATIONS,
	type LibraryCreate,
	type ProgramConfig,
} from '@moirai/shared';
import { loadConfig } from '@server/config.js';
import { createDatabase } from '@server/db/index.js';
import { mediaItems, scanRuns } from '@server/db/schema.js';
import { type DiscoveredGroup, type DiscoveredItem, Repository } from '@server/repository/index.js';

const cleanups: Array<() => Promise<void>> = [];

function item(index: number): DiscoveredItem {
	return {
		id: randomUUID(),
		aliasIds: [],
		groupId: null,
		stableKey: `movie-${index}`,
		kind: 'movie',
		title: `Movie ${index}`,
		sortTitle: `Movie ${index}`,
		relativePath: `Movie ${index}/Movie ${index}.mkv`,
		playbackPath: `/media/Movie ${index}/Movie ${index}.mkv`,
		nfoRelativePath: null,
		plot: null,
		year: null,
		durationMilliseconds: null,
		probeFingerprint: `probe-${index}`,
		probeStatus: 'failed',
		probeUpdatedAt: '2026-08-24T00:00:00.000Z',
		probeErrorCode: 'probe-failed',
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
		metadataStatus: 'incomplete',
		metadata: {},
		artworkRelativePath: null,
		fingerprint: `fingerprint-${index}`,
		fileModifiedAt: new Date(2025, 0, index + 1).toISOString(),
		titleBucket: 'M',
		genres: [],
		people: [],
	};
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Repository scan reconciliation', () => {
	it('returns one newest-first bounded content preview for every library', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-library-previews-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const populated = await repository.createLibrary({
			name: 'Populated',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: '/media' },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const empty = await repository.createLibrary({
			name: 'Empty',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: path.join(root, 'empty'), playbackRoot: '/media/empty' },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const older = { ...item(100), title: 'Older', sortTitle: 'Older' };
		await repository.reconcileScan(
			await repository.beginScan(populated.id, 'initial'),
			[],
			[older],
			[],
			true,
		);

		const recent = Array.from(
			{ length: MAX_LIBRARY_CONTENT_PREVIEW_ITEMS + 1 },
			(_, index) => ({
				...item(index),
				title: `Recent ${String(index).padStart(2, '0')}`,
				sortTitle: `Recent ${String(index).padStart(2, '0')}`,
				artworkRelativePath: index === 0 ? 'Recent 00/poster.jpg' : null,
			}),
		);
		await repository.reconcileScan(
			await repository.beginScan(populated.id, 'watcher'),
			[],
			[older, ...recent],
			[],
			true,
		);
		await database.db.update(mediaItems)
			.set({ dateAddedAt: '2026-08-01T00:00:00.000Z' })
			.where(eq(mediaItems.id, older.id));
		for (const recentItem of recent) {
			await database.db.update(mediaItems)
				.set({ dateAddedAt: '2026-08-02T00:00:00.000Z' })
				.where(eq(mediaItems.id, recentItem.id));
		}

		const previews = repository.listLibraryContentPreviews();
		expect(previews.find((preview) => preview.libraryId === empty.id)?.items).toEqual([]);
		const populatedItems = previews.find((preview) => preview.libraryId === populated.id)?.items;
		expect(populatedItems).toHaveLength(MAX_LIBRARY_CONTENT_PREVIEW_ITEMS);
		expect(populatedItems?.map((preview) => preview.title)).toEqual(
			recent.slice(0, MAX_LIBRARY_CONTENT_PREVIEW_ITEMS).map((preview) => preview.title),
		);
		expect(populatedItems?.[0]).toMatchObject({
			availability: 'available',
			artworkUrl: expect.stringContaining(`/api/v1/artwork/items/${recent[0]!.id}`),
		});
	});

	it('persists absorbed multipart IDs as catalog compatibility aliases', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-multipart-alias-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: '/media' },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const absorbed = item(1);
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			[],
			[absorbed],
			[],
			true,
		);
		const selectedProgram = await repository.createProgram({
			name: 'Pre-absorption selection',
			config: {
				type: 'content',
				source: {
					type: 'collection',
					libraryId: library.id,
					itemIds: [absorbed.id],
					sort: { type: 'manual', itemIds: [absorbed.id] },
				},
				strategy: { type: 'sequential' },
			},
		});
		const logical = {
			...item(2),
			aliasIds: [absorbed.id],
			multipartStatus: 'complete' as const,
		};

		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			[],
			[logical],
			[],
			true,
		);

		expect(await repository.getMediaItem(logical.aliasIds[0]!)).toMatchObject({
			id: logical.id,
			multipartStatus: 'complete',
		});
		expect(await repository.getMediaCardPreview(logical.aliasIds[0]!)).toMatchObject({
			id: logical.id,
			title: logical.title,
			plot: null,
			rating: null,
			primaryGenre: null,
			actors: [],
		});
		expect(await repository.listMediaItemsByIds(library.id, [absorbed.id]))
			.toMatchObject([{ id: logical.id }]);
		expect(await repository.listMediaItemsByIds(library.id, [absorbed.id], 'requested'))
			.toMatchObject([{ id: absorbed.id, title: logical.title }]);
		const addition = repository.appendProgramItems(
			selectedProgram.id,
			library.id,
			[logical.id],
		);
		expect(addition).toMatchObject({
			status: 'updated',
			changed: true,
			addedItemCount: 0,
			alreadySelectedCount: 1,
			program: {
				config: {
					source: {
						itemIds: [logical.id],
						sort: { type: 'manual', itemIds: [logical.id] },
					},
				},
			},
		});
	});

	it('does not fail when a provider returns duplicate normalized people', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-duplicate-people-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: '/media' },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const discovered = {
			...item(1),
			people: [
				{
					personType: 'actor' as const,
					name: 'Alex Smith',
					normalizedName: 'alex smith',
					role: null,
					sortOrder: 4,
				},
				{
					personType: 'actor' as const,
					name: 'ALEX SMITH',
					normalizedName: 'alex smith',
					role: 'Lead',
					sortOrder: 1,
				},
			],
		};

		const result = await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			[],
			[discovered],
			[],
			true,
		);

		expect(result.status).toBe('complete');
		expect(await repository.getMediaItem(discovered.id)).toMatchObject({
			actors: [{ name: 'Alex Smith', role: null }],
		});
	});

	it('requires spaced healthy observations before applying an ordinary removal', async () => {
		vi.useFakeTimers();
		const startedAt = new Date('2026-01-01T00:00:00.000Z');
		vi.setSystemTime(startedAt);
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-repository-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const input: LibraryCreate = {
			name: 'Movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: '/media' },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		};
		const library = await repository.createLibrary(input);
		const initialItems = Array.from({ length: 20 }, (_, index) => item(index));
		const initial = await repository.beginScan(library.id, 'initial');
		await repository.reconcileScan(initial, [], initialItems, [], true);

		for (let observation = 1; observation <= REMOVAL_CONFIRMATION_OBSERVATIONS; observation += 1) {
			vi.setSystemTime(
				new Date(
					startedAt.getTime() + observation * REMOVAL_CONFIRMATION_INTERVAL_MINUTES * 60_000,
				),
			);
			const scan = await repository.beginScan(library.id, 'periodic');
			const reconciled = await repository.reconcileScan(scan, [], initialItems.slice(1), [], true);
			expect(reconciled.removedCount).toBe(
				observation === REMOVAL_CONFIRMATION_OBSERVATIONS ? 1 : 0,
			);
		}
		expect(await repository.getLibrary(library.id)).toMatchObject({
			itemCount: initialItems.length - 1,
			sourceAvailability: 'available',
			reconciliationStatus: 'idle',
		});
		expect(
			(await repository.getSchedulingCatalog()).media.every(
				(media) => media.availability === 'available',
			),
		).toBe(true);
	});

	it('confirms only tombstoned physical paths without adding scan history', async () => {
		vi.useFakeTimers();
		const startedAt = new Date('2026-01-01T00:00:00.000Z');
		vi.setSystemTime(startedAt);
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-presence-reconciliation-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Targeted movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: '/media' },
			scanIntervalMinutes: 180,
			watcherEnabled: true,
			enabled: true,
		});
		const missing = {
			...item(1),
			multipartStatus: 'complete' as const,
			parts: [
				{
					number: 1,
					kind: 'part' as const,
					relativePath: 'Movie 1/Movie 1 Part 1.mkv',
					playbackPath: '/media/Movie 1/Movie 1 Part 1.mkv',
					durationSeconds: 60,
					subtitleTracks: [],
				},
				{
					number: 2,
					kind: 'part' as const,
					relativePath: 'Movie 1/Movie 1 Part 2.mkv',
					playbackPath: '/media/Movie 1/Movie 1 Part 2.mkv',
					durationSeconds: 60,
					subtitleTracks: [],
				},
			],
		};
		const retained = item(2);
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			[],
			[missing, retained],
			[],
			true,
		);
		vi.setSystemTime(new Date(startedAt.getTime() + 30 * 60_000));
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'watcher'),
			[],
			[retained],
			[],
			true,
		);

		let batch = await repository.getMissingItemPresenceBatch(library.id);
		expect(batch?.targets).toEqual([{
			itemId: missing.id,
			stableKey: missing.stableKey,
			relativePaths: missing.parts.map((part) => part.relativePath),
		}]);
		vi.setSystemTime(new Date(startedAt.getTime() + 60 * 60_000));
		const second = await repository.applyMissingItemPresence(
			library.id,
			batch!.revision,
			{
				sourceType: 'on-disk',
				sourceKey: root,
				details: { canonicalRoot: root },
			},
			[{ itemId: missing.id, status: 'absent' }],
		);
		expect(second).toMatchObject({ changed: true, removedItemIds: [], pendingRemovalCount: 1 });

		batch = await repository.getMissingItemPresenceBatch(library.id);
		vi.setSystemTime(new Date(startedAt.getTime() + 90 * 60_000));
		const third = await repository.applyMissingItemPresence(
			library.id,
			batch!.revision,
			{
				sourceType: 'on-disk',
				sourceKey: root,
				details: { canonicalRoot: root },
			},
			[{ itemId: missing.id, status: 'absent' }],
		);
		expect(third).toMatchObject({
			changed: true,
			removedItemIds: [missing.id],
			pendingRemovalCount: 0,
		});
		expect(await repository.listScans(library.id)).toHaveLength(2);
		expect(await repository.getLibrary(library.id)).toMatchObject({
			itemCount: 1,
			reconciliationStatus: 'idle',
			pendingRemovalCount: 0,
		});
	});

	it('preserves a tombstone when a targeted check finds its file present', async () => {
		vi.useFakeTimers();
		const startedAt = new Date('2026-01-01T00:00:00.000Z');
		vi.setSystemTime(startedAt);
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-restored-presence-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Restored movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: null },
			scanIntervalMinutes: 180,
			watcherEnabled: true,
			enabled: true,
		});
		const missing = item(1);
		const retained = item(2);
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			[],
			[missing, retained],
			[],
			true,
		);
		vi.setSystemTime(new Date(startedAt.getTime() + 30 * 60_000));
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'watcher'),
			[],
			[retained],
			[],
			true,
		);
		const batch = await repository.getMissingItemPresenceBatch(library.id);
		vi.setSystemTime(new Date(startedAt.getTime() + 60 * 60_000));

		const result = await repository.applyMissingItemPresence(
			library.id,
			batch!.revision,
			{ sourceType: 'on-disk', sourceKey: root, details: {} },
			[{ itemId: missing.id, status: 'present' }],
		);

		expect(result).toMatchObject({
			applied: true,
			changed: false,
			presentItemIds: [missing.id],
			removedItemIds: [],
		});
		expect(await repository.getLibraryReconciliation(library.id)).toMatchObject({
			status: 'observing-removals',
			pendingRemovalCount: 1,
		});
	});

	it('heals present items without approving absent items from a major removal', async () => {
		vi.useFakeTimers();
		const startedAt = new Date('2026-01-01T00:00:00.000Z');
		vi.setSystemTime(startedAt);
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-major-removal-healing-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Major removal movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: null },
			scanIntervalMinutes: 180,
			watcherEnabled: true,
			enabled: true,
		});
		const restored = item(1);
		const absent = item(2);
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			[],
			[restored, absent],
			[],
			true,
		);
		vi.setSystemTime(new Date(startedAt.getTime() + 30 * 60_000));
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'watcher'),
			[],
			[],
			[],
			true,
		);
		const batch = await repository.getMissingItemPresenceBatch(library.id);
		expect(batch).toMatchObject({ mode: 'heal-only' });
		expect(batch?.targets).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					itemId: restored.id,
					relativePaths: [restored.relativePath],
				}),
				expect.objectContaining({
					itemId: absent.id,
					relativePaths: [absent.relativePath],
				}),
			]),
		);
		vi.setSystemTime(new Date(startedAt.getTime() + 60 * 60_000));

		const result = await repository.applyMissingItemPresence(
			library.id,
			batch!.revision,
			{ sourceType: 'on-disk', sourceKey: root, details: {} },
			[
				{ itemId: restored.id, status: 'present' },
				{ itemId: absent.id, status: 'absent' },
			],
		);

		expect(result).toMatchObject({
			applied: true,
			changed: true,
			presentItemIds: [restored.id],
			restoredItemIds: [restored.id],
			removedItemIds: [],
			pendingRemovalCount: 1,
		});
		expect(await repository.listMediaItemsByIds(library.id, [restored.id, absent.id]))
			.toMatchObject([
				{ id: restored.id, availability: 'available' },
				{ id: absent.id, availability: 'unconfirmed' },
			]);
		expect(await repository.getLibraryReconciliation(library.id)).toMatchObject({
			status: 'removal-approval-required',
			pendingRemovalCount: 1,
			missingItems: [{ id: absent.id, consecutiveObservations: 1 }],
		});
		const remainingBatch = await repository.getMissingItemPresenceBatch(library.id);
		expect(remainingBatch).toMatchObject({
			mode: 'heal-only',
			targets: [{ itemId: absent.id }],
		});
		vi.setSystemTime(new Date(startedAt.getTime() + 90 * 60_000));
		const stillAbsent = await repository.applyMissingItemPresence(
			library.id,
			remainingBatch!.revision,
			{ sourceType: 'on-disk', sourceKey: root, details: {} },
			[{ itemId: absent.id, status: 'absent' }],
		);
		expect(stillAbsent).toMatchObject({
			changed: false,
			removedItemIds: [],
			restoredItemIds: [],
			pendingRemovalCount: 1,
		});
		expect(await repository.getLibraryReconciliation(library.id)).toMatchObject({
			status: 'removal-approval-required',
			missingItems: [{ id: absent.id, consecutiveObservations: 1 }],
		});
	});

	it.each(['none', 'same-scan', 'newer-failure'] as const)('clears approved removal warnings while preserving %s unrelated issues', async (otherIssue) => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-empty-reconciliation-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Small library',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: null },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const initial = await repository.beginScan(library.id, 'initial');
		await repository.reconcileScan(initial, [], [item(1)], [], true);
		vi.setSystemTime(new Date('2026-09-14T12:01:00Z'));
		const empty = await repository.beginScan(library.id, 'periodic');
		const unrelated = { code: 'metadata_warning', message: 'Metadata needs review.', path: null, severity: 'warning' as const };
		const result = await repository.reconcileScan(empty, [], [], otherIssue === 'same-scan' ? [unrelated] : [], true);
		expect(result).toMatchObject({ status: 'partial', removedCount: 0 });
		expect(result.issues).toContainEqual(expect.objectContaining({
			message: '1 missing item requires explicit reconciliation.',
		}));
		const reconciliation = await repository.getLibraryReconciliation(library.id);
		expect(reconciliation).toMatchObject({
			status: 'removal-approval-required',
			pendingRemovalCount: 1,
		});
		if (otherIssue === 'newer-failure') {
			vi.setSystemTime(new Date('2026-09-14T12:02:00Z'));
			await repository.failScan(await repository.beginScan(library.id, 'manual'), new Error('Source scan failed'));
		}
		expect(await repository.confirmLibraryRemovals(library.id, randomUUID())).toBe(false);
		expect(await repository.confirmLibraryRemovals(library.id, reconciliation!.revision!)).toBe(
			true,
		);
		expect(await repository.getLibrary(library.id)).toMatchObject({
			itemCount: 0, pendingRemovalCount: 0, warningCount: otherIssue === 'none' ? 0 : 1,
		});
		expect(await repository.getLibraryReconciliation(library.id)).toMatchObject({ status: 'idle' });
		expect((await repository.listScans(library.id)).find(scan => scan.id === empty.id)?.issues).toEqual(result.issues);
	});

	it('stages a changed canonical source root without mixing candidate media into the index', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-source-identity-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Mounted source',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: null },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const acceptedIdentity = {
			sourceType: 'on-disk' as const,
			sourceKey: root,
			details: { canonicalRoot: root, device: '1', inode: '1' },
		};
		const replacementIdentity = {
			...acceptedIdentity,
			sourceKey: `${root}-replacement`,
			details: { canonicalRoot: `${root}-replacement`, device: '2', inode: '2' },
		};
		const oldItem = item(1);
		const newItem = item(2);
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			[],
			[oldItem],
			[],
			true,
			acceptedIdentity,
		);
		const candidate = await repository.reconcileScan(
			await repository.beginScan(library.id, 'periodic'),
			[],
			[newItem],
			[],
			true,
			replacementIdentity,
		);
		expect(candidate.status).toBe('partial');
		expect(await repository.listMediaItemsByIds(library.id, [oldItem.id, newItem.id])).toEqual([
			expect.objectContaining({ id: oldItem.id, availability: 'unconfirmed' }),
		]);
		const reconciliation = await repository.getLibraryReconciliation(library.id);
		expect(reconciliation).toMatchObject({
			status: 'source-approval-required',
			candidateSummary: { discoveredCount: 1, addedCount: 1, missingCount: 1 },
		});
		expect(await repository.authorizeSourceAcceptance(library.id, reconciliation!.revision!)).toBe(
			true,
		);
		const replacement = await repository.reconcileScan(
			await repository.beginScan(library.id, 'manual'),
			[],
			[newItem],
			[],
			true,
			replacementIdentity,
		);
		expect(replacement).toMatchObject({ status: 'complete', removedCount: 1 });
		expect(await repository.listMediaItemsByIds(library.id, [oldItem.id, newItem.id])).toEqual([
			expect.objectContaining({ id: newItem.id, availability: 'available' }),
		]);
	});

	it('accepts a healthy remount at the same canonical source root', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-source-remount-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Remounted source',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: null },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const media = item(1);
		const initial = {
			sourceType: 'on-disk' as const,
			sourceKey: root,
			details: { canonicalRoot: root, device: '1', inode: '1' },
		};
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			[],
			[media],
			[],
			true,
			initial,
		);

		const remounted = await repository.reconcileScan(
			await repository.beginScan(library.id, 'periodic'),
			[],
			[media],
			[],
			true,
			{ ...initial, details: { ...initial.details, device: '9', inode: '99' } },
		);

		expect(remounted).toMatchObject({ status: 'complete', removedCount: 0 });
		expect(await repository.getLibraryReconciliation(library.id)).toMatchObject({
			status: 'idle',
			pendingRemovalCount: 0,
		});
		expect(await repository.listMediaItemsByIds(library.id, [media.id])).toEqual([
			expect.objectContaining({ id: media.id, availability: 'available' }),
		]);
		expect(await repository.libraryNeedsMediaProbe(library.id)).toBe(true);
	});

	it('pages title and genre placements while retaining stable added dates and detail credits', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-browse-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Movies',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: '/media' },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const alpha = {
			...item(1),
			durationMilliseconds: 98_765,
			probeStatus: 'complete' as const,
			probeErrorCode: null,
			title: 'Alpha',
			sortTitle: 'Alpha',
			titleBucket: 'A',
			plot: 'A navigator charts a course through an unstable frontier.',
			metadata: {
				releaseDate: '2001-06-01',
				rating: 8.2,
				userRating: 9.1,
				genres: ['Science Fiction', 'Drama'],
			},
			genres: [
				{ key: 'drama', name: 'Drama' },
				{ key: 'science-fiction', name: 'Science Fiction' },
			],
			people: [
				{
					personType: 'actor' as const,
					name: 'Aaron Unbilled',
					normalizedName: 'aaron unbilled',
					role: 'Bystander',
					sortOrder: null,
				},
				{
					personType: 'actor' as const,
					name: 'Ada Actor',
					normalizedName: 'ada actor',
					role: 'Navigator',
					sortOrder: 1,
				},
				{
					personType: 'actor' as const,
					name: 'Bea Performer',
					normalizedName: 'bea performer',
					role: 'Pilot',
					sortOrder: 2,
				},
				{
					personType: 'actor' as const,
					name: 'Cora Player',
					normalizedName: 'cora player',
					role: 'Engineer',
					sortOrder: 3,
				},
				{
					personType: 'director' as const,
					name: 'Dee Director',
					normalizedName: 'dee director',
					role: null,
					sortOrder: null,
				},
			],
		};
		const beta = {
			...item(2),
			title: 'Beta',
			sortTitle: 'Beta',
			titleBucket: 'B',
			metadata: { rating: 9.3, userRating: 6 },
			genres: [{ key: 'drama', name: 'Drama' }],
		};
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			[],
			[alpha, beta],
			[],
			true,
		);
		expect(await repository.listMediaGenres(library.id)).toEqual([
			{ key: 'drama', name: 'Drama', count: 2, excludeCount: null },
			{ key: 'science-fiction', name: 'Science Fiction', count: 1, excludeCount: null },
		]);
		expect(await repository.listMediaGenres(library.id, {
			genres: [],
			excludedGenres: [],
		})).toEqual([
			{ key: 'drama', name: 'Drama', count: 2, excludeCount: 0 },
			{ key: 'science-fiction', name: 'Science Fiction', count: 1, excludeCount: 1 },
		]);
		expect(await repository.listMediaGenres(library.id, {
			genres: ['science-fiction'],
			excludedGenres: [],
		})).toEqual([
			{ key: 'drama', name: 'Drama', count: 1, excludeCount: 0 },
			{ key: 'science-fiction', name: 'Science Fiction', count: 1, excludeCount: 1 },
		]);
		expect(await repository.listMediaGenres(library.id, {
			genres: ['drama', 'science-fiction'],
			excludedGenres: [],
		})).toEqual([
			{ key: 'drama', name: 'Drama', count: 1, excludeCount: 0 },
			{ key: 'science-fiction', name: 'Science Fiction', count: 1, excludeCount: 1 },
		]);
		expect(await repository.listMediaGenres(library.id, {
			genres: [],
			excludedGenres: ['science-fiction'],
		})).toEqual([
			{ key: 'drama', name: 'Drama', count: 1, excludeCount: 0 },
			{ key: 'science-fiction', name: 'Science Fiction', count: 1, excludeCount: 1 },
		]);
		expect(await repository.listMediaGenres(library.id, {
			genres: ['missing'],
			excludedGenres: [],
		})).toEqual([
			{ key: 'drama', name: 'Drama', count: 0, excludeCount: 0 },
			{ key: 'science-fiction', name: 'Science Fiction', count: 0, excludeCount: 0 },
		]);
		const baseQuery = {
			parentId: null,
			page: 1,
			pageSize: 1,
			sort: 'title' as const,
			direction: 'asc' as const,
			name: '',
			releaseYearFrom: null,
			releaseYearTo: null,
			minimumRating: null,
			minimumUserRating: null,
			addedFrom: null,
			addedBefore: null,
			genres: [],
			excludedGenres: [],
			genreMatch: 'any' as const,
			actor: '',
			director: '',
		};
		expect((await repository.browseMedia(library.id, { ...baseQuery, search: 'lpha' })).items.map(item => item.id))
			.toEqual([alpha.id]);
		for (const [search, field] of [['alpHA', 'title'], ['Sci-Fi', 'genre'], ['Performer', 'actor'], ['Director', 'director'], ['UNSTABLE frontier', 'plot']] as const) {
			const result = await repository.browseMedia(library.id, { ...baseQuery, search });
			expect(result.items.map(item => item.id)).toEqual([alpha.id]);
			expect(result.entries[0]?.matches?.some(match => match.field === field)).toBe(true);
			const picked = await repository.browseMediaSourceOptions(library.id, { target: 'items', search, parentId: null, page: 1, pageSize: 50 });
			expect(picked.entries.map(entry => entry.item?.id)).toEqual([alpha.id]);
			expect(picked.entries[0]?.matches?.some(match => match.field === field)).toBe(true);
			expect(repository.resolveProgramItemSelection(library.id, { ...baseQuery, search }).itemIds).toEqual([alpha.id]);
		}
		expect((await repository.browseMedia(library.id, { ...baseQuery, search: 'frontier', name: 'Beta' })).items).toEqual([]);
		const paged = await repository.browseMedia(library.id, { ...baseQuery, search: 'Drama', page: 2 });
		expect(paged.pagination.totalEntries).toBe(2);
		expect(paged.items.map(item => item.id)).toEqual([beta.id]);
		expect(paged.navigation).toEqual([]);
		expect((await repository.browseMedia(library.id, { ...baseQuery, search: 'Drama', name: 'Beta' })).items.map(item => item.id)).toEqual([beta.id]);
		expect((await repository.browseMedia(library.id, { ...baseQuery, search: 'Director', genres: ['science-fiction'] })).items.map(item => item.id)).toEqual([alpha.id]);
		for (const search of ['%', '_', '\\']) {
			expect((await repository.browseMedia(library.id, { ...baseQuery, search })).items).toEqual([]);
		}

		const titlePage = await repository.browseMedia(library.id, baseQuery);
		expect(titlePage.entries[0]?.item?.title).toBe('Alpha');
		expect(titlePage.navigation).toMatchObject([
			{ key: 'A', firstPage: 1 },
			{ key: 'B', firstPage: 2 },
		]);
		expect(titlePage.entries[0]?.item?.dateAddedAt).toBe(alpha.fileModifiedAt);
		expect(titlePage.entries[0]?.item).toMatchObject({
			availability: 'available',
			lastObservedAt: expect.any(String),
		});

		const genrePage = await repository.browseMedia(library.id, {
			...baseQuery,
			pageSize: 10,
			sort: 'genre',
		});
		expect(genrePage.pagination.totalEntries).toBe(3);
		expect(genrePage.navigation.map((entry) => entry.key)).toEqual(['drama', 'science-fiction']);

		const actorResult = await repository.browseMedia(library.id, {
			...baseQuery,
			pageSize: 10,
			actor: 'Ada',
		});
		expect(actorResult.items.map((entry) => entry.title)).toEqual(['Alpha']);
		const popularRatingResult = await repository.browseMedia(library.id, {
			...baseQuery,
			pageSize: 10,
			minimumRating: 9,
		});
		expect(popularRatingResult.items.map((entry) => entry.title)).toEqual(['Beta']);
		const userRatingResult = await repository.browseMedia(library.id, {
			...baseQuery,
			pageSize: 10,
			minimumUserRating: 9,
		});
		expect(userRatingResult.items.map((entry) => entry.title)).toEqual(['Alpha']);
		const combinedRatingResult = await repository.browseMedia(library.id, {
			...baseQuery,
			pageSize: 10,
			minimumRating: 9,
			minimumUserRating: 9,
		});
		expect(combinedRatingResult.items).toEqual([]);
		const excludedGenreResult = await repository.browseMedia(library.id, {
			...baseQuery,
			pageSize: 10,
			genres: ['drama'],
			excludedGenres: ['science-fiction'],
			genreMatch: 'all',
		});
		expect(excludedGenreResult.items.map((entry) => entry.title)).toEqual(['Beta']);
		const programSelection = repository.resolveProgramItemSelection(library.id, {
			...baseQuery,
			sort: 'genre',
			genres: ['drama'],
			genreMatch: 'all',
		});
		expect(programSelection).toEqual({
			itemIds: [alpha.id, beta.id],
			matchedItemCount: 2,
		});
		const selectedProgram = await repository.createProgram({
			name: 'Selected films',
			config: {
				type: 'content',
				source: {
					type: 'collection',
					libraryId: library.id,
					itemIds: [alpha.id],
					sort: { type: 'manual', itemIds: [alpha.id] },
				},
				strategy: { type: 'shuffle', seed: 'stable' },
			},
		});
		const appended = repository.appendProgramItems(
			selectedProgram.id,
			library.id,
			programSelection.itemIds,
		);
		expect(appended).toMatchObject({
			status: 'updated',
			addedItemCount: 1,
			alreadySelectedCount: 1,
			program: {
				config: {
					source: {
						itemIds: [alpha.id, beta.id],
						sort: { type: 'manual', itemIds: [alpha.id, beta.id] },
					},
					strategy: { type: 'shuffle', seed: 'stable' },
				},
			},
		});
		expect(actorResult.items[0]).toMatchObject({
			availability: 'available',
			lastObservedAt: expect.any(String),
		});
		expect(await repository.getMediaItem(alpha.id)).toMatchObject({
			durationSeconds: 98.765,
			releaseDate: '2001-06-01',
			genres: ['Drama', 'Science Fiction'],
			actors: [
				{ name: 'Ada Actor', role: 'Navigator', sortOrder: 1 },
				{ name: 'Bea Performer', role: 'Pilot', sortOrder: 2 },
				{ name: 'Cora Player', role: 'Engineer', sortOrder: 3 },
				{ name: 'Aaron Unbilled', role: 'Bystander', sortOrder: null },
			],
		});
		expect(await repository.getMediaCardPreview(alpha.id)).toMatchObject({
			id: alpha.id,
			title: 'Alpha',
			plot: alpha.plot,
			rating: 8.2,
			primaryGenre: 'Science Fiction',
			actors: ['Ada Actor', 'Bea Performer', 'Cora Player'],
		});
		expect(await repository.getMediaCardPreview(beta.id)).toMatchObject({
			id: beta.id,
			primaryGenre: 'Drama',
		});
		expect(await repository.listMediaItemsByIds(library.id, [beta.id, alpha.id])).toMatchObject([
			{ title: 'Beta', durationSeconds: null },
			{ title: 'Alpha', durationSeconds: 98.765 },
		]);

		const genreSources = await repository.browseMediaSourceOptions(library.id, {
			target: 'items',
			parentId: null,
			page: 1,
			pageSize: 10,
			search: 'Sci-Fi',
		});
		expect(genreSources.entries).toMatchObject([
			{ item: { title: 'Alpha' }, matches: [{ field: 'genre', label: 'Science Fiction' }] },
		]);
		const peopleSources = await repository.browseMediaSourceOptions(library.id, {
			target: 'items',
			parentId: null,
			page: 1,
			pageSize: 10,
			search: 'Director',
		});
		expect(peopleSources.entries[0]?.matches).toContainEqual({
			field: 'director',
			label: 'Dee Director',
		});
		const special = { ...item(3), title: 'Literal %_\\ Name', plot: 'Synopsis %_\\ detail', metadata: {}, artists: ['Literal %_\\ Credit'] };
		await repository.reconcileScan(await repository.beginScan(library.id, 'manual'), [], [alpha, beta, special], [], true);
		for (const search of ['%', '_', '\\']) {
			const found = await repository.browseMedia(library.id, { ...baseQuery, search });
			expect(found.items.map(item => item.id)).toEqual([special.id]);
			expect(found.entries[0]?.matches?.map(match => match.field)).toEqual(['artist', 'plot', 'title']);
		}
		const plotSearch = 'Synopsis %_\\';
		const plotted = await repository.browseMedia(library.id, { ...baseQuery, search: plotSearch });
		expect(plotted.entries).toMatchObject([{ item: { id: special.id }, matches: [{ field: 'plot', label: special.plot }] }]);
		const pickedPlot = await repository.browseMediaSourceOptions(library.id, { target: 'items', search: plotSearch, parentId: null, page: 1, pageSize: 50 });
		expect(pickedPlot.entries).toMatchObject([{ item: { id: special.id }, matches: [{ field: 'plot', label: special.plot }] }]);

	});

	it('keeps show and season source results separate from playable items', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-show-sources-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Shows',
			typeKey: 'shows',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: '/media' },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const showId = randomUUID();
		const seasonId = randomUUID();
		const groups: DiscoveredGroup[] = [
			{
				id: showId,
				stableKey: 'show:space-station',
				parentId: null,
				kind: 'show',
				title: 'Space Station',
				sortTitle: 'Space Station',
				year: 2020,
				plot: null,
				metadata: { yearEnd: 2022 },
				artworkRelativePath: null,
			},
			{
				id: seasonId,
				stableKey: 'show:space-station:season:1',
				parentId: showId,
				kind: 'season',
				title: 'Season 1',
				sortTitle: '00001',
				year: 2020,
				plot: null,
				metadata: { seasonNumber: 1 },
				artworkRelativePath: null,
			},
		];
		const episode = {
			...item(3),
			groupId: seasonId,
			kind: 'episode',
			title: 'First Contact',
			sortTitle: 'First Contact',
			seasonNumber: 1,
			episodeNumber: 1,
			genres: [{ key: 'science-fiction', name: 'Science Fiction' }],
			people: [
				{
					personType: 'actor' as const,
					name: 'Nova Performer',
					normalizedName: 'nova performer',
					role: 'Commander',
					sortOrder: 1,
				},
			],
		};
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			groups,
			[episode],
			[],
			true,
		);
		const recursiveSelection = repository.resolveProgramItemSelection(library.id, {
			parentId: showId,
			sort: 'title',
			direction: 'asc',
			name: '',
			releaseYearFrom: null,
			releaseYearTo: null,
			minimumRating: null,
			minimumUserRating: null,
			addedFrom: null,
			addedBefore: null,
			genres: [],
			excludedGenres: [],
			genreMatch: 'all',
			actor: '',
			director: '',
		});
		expect(recursiveSelection).toEqual({ itemIds: [episode.id], matchedItemCount: 1 });

		const rootGroups = await repository.browseMediaSourceOptions(library.id, {
			target: 'groups',
			parentId: null,
			page: 1,
			pageSize: 10,
			search: '',
		});
		expect(rootGroups.entries.map((entry) => entry.group?.kind)).toEqual(['show']);
		expect(rootGroups.entries.every((entry) => entry.item === null)).toBe(true);

		const seasons = await repository.browseMediaSourceOptions(library.id, {
			target: 'groups',
			parentId: showId,
			page: 1,
			pageSize: 10,
			search: '',
		});
		expect(seasons.entries.map((entry) => entry.group?.kind)).toEqual(['season']);
		expect(
			await repository.listMediaGroupsByIds(library.id, [randomUUID(), seasonId, showId]),
		).toMatchObject([
			{ id: seasonId, kind: 'season', title: 'Season 1' },
			{ id: showId, kind: 'show', title: 'Space Station' },
		]);

		const genreGroups = await repository.browseMediaSourceOptions(library.id, {
			target: 'groups',
			parentId: null,
			page: 1,
			pageSize: 10,
			search: 'Sci-Fi',
		});
		expect(genreGroups.entries.map((entry) => entry.group?.kind)).toEqual(['season', 'show']);
		expect(
			genreGroups.entries.every((entry) =>
				entry.matches.some((match) => match.field === 'genre' && match.label === 'Science Fiction')),
		).toBe(true);

		const showSearch = await repository.browseMedia(library.id, {
			parentId: null,
			page: 1,
			pageSize: 10,
			sort: 'title',
			direction: 'asc',
			name: '',
			search: 'Space',
			releaseYearFrom: null,
			releaseYearTo: null,
			minimumRating: null,
			minimumUserRating: null,
			addedFrom: null,
			addedBefore: null,
			genres: [],
			excludedGenres: [],
			genreMatch: 'any',
			actor: '',
			director: '',
		});
		expect(showSearch.items.map((entry) => entry.title)).toEqual(['First Contact']);
		expect(showSearch.groups).toEqual([]);

		const inheritedTitle = await repository.browseMediaSourceOptions(library.id, {
			target: 'items',
			parentId: null,
			page: 1,
			pageSize: 10,
			search: 'Space Station',
		});
		expect(inheritedTitle.entries).toMatchObject([
			{ item: { title: 'First Contact' }, matches: [{ field: 'show', label: 'Space Station' }] },
		]);
		const browsed = await repository.browseMedia(library.id, {
			...catalogProgramItemQuerySchema.parse({ search: 'Space Station' }), page: 1, pageSize: 10,
		});
		expect(browsed.entries.map(entry => entry.matches)).toEqual(inheritedTitle.entries.map(entry => entry.matches));

		database.sqlite.prepare('UPDATE media_groups SET title = ?, sort_title = ? WHERE id = ?')
			.run('Renamed Station', 'Renamed Station', showId);
		expect((await repository.browseMedia(library.id, {
			...catalogProgramItemQuerySchema.parse({ search: 'Space Station' }), page: 1, pageSize: 10,
		})).items).toEqual([]);
		expect((await repository.browseMedia(library.id, {
			...catalogProgramItemQuerySchema.parse({ search: 'Renamed' }), page: 1, pageSize: 10,
		})).items.map((entry) => entry.title)).toEqual(['First Contact']);
	});
});

describe('Repository scheduling catalog', () => {
	it('loads large explicit selections without expanding identifiers into SQL bind lists', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-large-catalog-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Large library',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: '/media' },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const items = Array.from({ length: 1_200 }, (_, index) => ({
			...item(index),
			genres: [{ key: 'science-fiction', name: 'Science Fiction' }],
		}));
		const scan = await repository.beginScan(library.id, 'initial');
		await repository.reconcileScan(scan, [], items, [], true);
		const programs = await Promise.all(
			[0, 400, 800].map((start, index) =>
				repository.createProgram({
					name: `Collection ${index + 1}`,
					config: {
						type: 'content',
						source: {
							type: 'collection',
							libraryId: library.id,
							itemIds: items.slice(start, start + 400).map((entry) => entry.id),
							sort: { type: 'date-added', direction: 'asc' },
						},
						strategy: { type: 'sequential' },
					},
				})),
		);
		const confirmationProgram = await repository.createProgram({
			name: 'Confirmation collection',
			config: {
				type: 'content',
				source: {
					type: 'collection',
					libraryId: library.id,
					itemIds: [items[0]!.id],
					sort: { type: 'name', direction: 'asc' },
				},
				strategy: { type: 'sequential' },
			},
		});
		const editedConfig = {
			type: 'content',
			source: {
				type: 'collection',
				libraryId: library.id,
				itemIds: [items[0]!.id],
				sort: { type: 'date-added', direction: 'desc' },
			},
			strategy: { type: 'sequential' },
		} satisfies ProgramConfig;
		const editedProgram = await repository.createProgram({
			name: 'Edited collection',
			config: editedConfig,
		});
		const edited = await repository.updateProgram(editedProgram.id, {
			config: {
				...editedConfig,
				source: {
					...editedConfig.source,
					itemIds: [items[0]!.id, items[1]!.id, items[2]!.id],
				},
			},
		});
		expect(edited?.config).toMatchObject({
			source: {
				additionBatches: [[items[0]!.id], [items[1]!.id, items[2]!.id]],
			},
		});
		const capacity = repository.appendProgramItems(
			programs[0]!.id,
			library.id,
			items.slice(400, 501).map((entry) => entry.id),
			undefined,
			500,
		);
		expect(capacity).toEqual({
			status: 'capacity',
			addedItemCount: 101,
			alreadySelectedCount: 0,
			remainingItemCount: 100,
		});
		const unchangedProgram = await repository.getProgram(programs[0]!.id);
		expect(unchangedProgram?.config).toEqual(programs[0]!.config);

		const confirmationItemIds = items
			.slice(0, PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 2)
			.map((entry) => entry.id);
		const confirmation = repository.appendProgramItems(
			confirmationProgram.id,
			library.id,
			confirmationItemIds,
		);
		expect(confirmation.status).toBe('confirmation-required');
		if (confirmation.status !== 'confirmation-required') {
			throw new Error('Expected a program-item confirmation challenge');
		}
		expect(confirmation).toMatchObject({
			status: 'confirmation-required',
			addedItemCount: PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 1,
			addedItemIds: confirmationItemIds.slice(1),
			alreadySelectedCount: 1,
		});
		expect(confirmation.confirmationToken).toMatch(/^[a-f0-9]{64}$/);
		expect((await repository.getProgram(confirmationProgram.id))?.config)
			.toEqual(confirmationProgram.config);

		const reorderedConfirmationItemIds = [
			confirmationItemIds[0]!,
			...confirmationItemIds.slice(1).reverse(),
		];
		const reorderedSequentialConfirmation = repository.appendProgramItems(
			confirmationProgram.id,
			library.id,
			reorderedConfirmationItemIds,
			confirmation.confirmationToken,
		);
		expect(reorderedSequentialConfirmation).toMatchObject({
			status: 'confirmation-required',
			addedItemIds: reorderedConfirmationItemIds.slice(1),
		});
		if (reorderedSequentialConfirmation.status !== 'confirmation-required') {
			throw new Error('Expected sequential item reordering to invalidate confirmation');
		}
		expect(reorderedSequentialConfirmation.confirmationToken)
			.not.toBe(confirmation.confirmationToken);

		const changedConfirmationItemIds = [
			...confirmationItemIds.slice(0, -1),
			items[PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 2]!.id,
		];
		const staleConfirmation = repository.appendProgramItems(
			confirmationProgram.id,
			library.id,
			changedConfirmationItemIds,
			confirmation.confirmationToken,
		);
		expect(staleConfirmation).toMatchObject({
			status: 'confirmation-required',
			addedItemCount: PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 1,
			addedItemIds: changedConfirmationItemIds.slice(1),
			alreadySelectedCount: 1,
		});
		if (staleConfirmation.status !== 'confirmation-required') {
			throw new Error('Expected changed identifiers to invalidate confirmation');
		}
		expect(staleConfirmation.confirmationToken).not.toBe(confirmation.confirmationToken);
		expect((await repository.getProgram(confirmationProgram.id))?.config)
			.toEqual(confirmationProgram.config);

		const confirmed = repository.appendProgramItems(
			confirmationProgram.id,
			library.id,
			confirmationItemIds,
			confirmation.confirmationToken,
		);
		expect(confirmed).toMatchObject({
			status: 'updated',
			addedItemCount: PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD + 1,
			alreadySelectedCount: 1,
			program: {
				config: {
					source: {
						itemIds: confirmationItemIds,
						additionBatches: [[confirmationItemIds[0]!], confirmationItemIds.slice(1)],
					},
				},
			},
		});

		for (const strategyType of ['shuffle', 'random', 'weighted-random'] as const) {
			const unorderedProgram = await repository.createProgram({
				name: `${strategyType} confirmation collection`,
				config: {
					type: 'content',
					source: {
						type: 'collection',
						libraryId: library.id,
						itemIds: [confirmationItemIds[0]!],
						sort: { type: 'date-added', direction: 'asc' },
					},
					strategy: { type: strategyType, seed: '' },
				},
			});
			const unorderedConfirmation = repository.appendProgramItems(
				unorderedProgram.id,
				library.id,
				confirmationItemIds,
			);
			if (unorderedConfirmation.status !== 'confirmation-required') {
				throw new Error(`Expected a ${strategyType} program confirmation challenge`);
			}

			const reorderedConfirmation = repository.appendProgramItems(
				unorderedProgram.id,
				library.id,
				reorderedConfirmationItemIds,
				unorderedConfirmation.confirmationToken,
			);
			expect(reorderedConfirmation).toMatchObject({
				status: 'updated',
				program: {
					config: {
						source: {
							itemIds: reorderedConfirmationItemIds,
							additionBatches: [
								[reorderedConfirmationItemIds[0]!],
								reorderedConfirmationItemIds.slice(1),
							],
						},
					},
				},
			});
		}

		const catalog = await repository.getSchedulingCatalog(programs, programs.map((program) => program.id));

		expect(catalog.media).toHaveLength(items.length);
		expect(catalog.media.every((media) => media.genres.includes('science-fiction'))).toBe(true);
	}, 15_000);
});

describe('operational history retention', () => {
	it('applies age and count limits while preserving running scans', async () => {
		vi.useFakeTimers();
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-retention-'));
		const config = loadConfig({
			dataDir: root,
			databasePath: path.join(root, 'test.sqlite'),
			migrationsDir: path.resolve('drizzle'),
		});
		const database = createDatabase(config.databasePath, config.migrationsDir);
		cleanups.push(async () => {
			database.close();
			await rm(root, { recursive: true, force: true });
		});
		const repository = new Repository(database.db);
		const library = await repository.createLibrary({
			name: 'Retention',
			typeKey: 'movies',
			sourceType: 'on-disk',
			sourceConfig: { scanRoot: root, playbackRoot: null },
			scanIntervalMinutes: 15,
			watcherEnabled: false,
			enabled: true,
		});
		const runningDate = new Date('2026-01-01T00:00:00.000Z');
		vi.setSystemTime(runningDate);
		const running = await repository.beginScan(library.id, 'manual');
		for (const date of ['2026-01-10', '2026-01-25', '2026-01-29', '2026-01-30']) {
			vi.setSystemTime(new Date(`${date}T00:00:00.000Z`));
			const scan = await repository.beginScan(library.id, 'periodic');
			await repository.cancelScan(scan);
		}
		repository.pruneScanHistory(
			{ scanDays: 20, scansPerLibrary: 2 },
			new Date('2026-01-31T00:00:00.000Z'),
		);
		const retainedScans = await database.db.select().from(scanRuns);
		expect(retainedScans.map((scan) => scan.id)).toContain(running.id);
		expect(retainedScans.filter((scan) => scan.status !== 'running')).toHaveLength(2);
	});
});
