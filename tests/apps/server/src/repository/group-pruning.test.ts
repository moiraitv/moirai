import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase } from '@server/db/index.js';
import {
	libraries,
	mediaGroups,
	mediaRemovalTombstones,
} from '@server/db/schema.js';
import { Repository, type DiscoveredGroup, type DiscoveredItem } from '@server/repository/index.js';

const databases: Array<ReturnType<typeof createDatabase>> = [];

function item(id: string, groupId: string, relativePath: string): DiscoveredItem {
	return {
		id,
		aliasIds: [],
		groupId,
		stableKey: relativePath,
		kind: 'episode',
		title: relativePath,
		sortTitle: relativePath,
		relativePath,
		playbackPath: `/media/${relativePath}`,
		nfoRelativePath: null,
		plot: null,
		year: null,
		durationMilliseconds: 1_800_000,
		probeFingerprint: `probe:${relativePath}`,
		probeStatus: 'complete',
		probeUpdatedAt: '2026-08-24T00:00:00Z',
		probeErrorCode: null,
		technicalMetadata: {},
		seasonNumber: 1,
		episodeNumber: 1,
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
		fingerprint: `metadata:${relativePath}`,
		fileModifiedAt: '2026-08-23T00:00:00Z',
		titleBucket: 'E',
		genres: [],
		people: [],
	};
}

afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close();
	}
});

describe('media group pruning', () => {
	it('retains a show parent while a child season still contains media', async () => {
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
		const groups: DiscoveredGroup[] = [
			{
				id: showId,
				stableKey: 'show:Example',
				sourceKey: 'show:Example',
				parentId: null,
				kind: 'show',
				title: 'Example',
				sortTitle: 'Example',
				year: null,
				plot: null,
				metadata: {},
				artworkRelativePath: null,
				posterRelativePath: null,
				landscapeRelativePath: null,
				fanartRelativePath: null,
			},
			{
				id: seasonId,
				stableKey: 'show:Example:season:1',
				sourceKey: 'show:Example:season:1',
				parentId: showId,
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
			},
		];
		const removedId = crypto.randomUUID();
		const retainedId = crypto.randomUUID();
		await repository.reconcileScan(
			await repository.beginScan(library.id, 'initial'),
			groups,
			[
				item(removedId, seasonId, 'Example/Season 01/Episode 1.mkv'),
				item(retainedId, seasonId, 'Example/Season 01/Episode 2.mkv'),
			],
			[],
			true,
		);
		const revision = crypto.randomUUID();
		await database.db.insert(mediaRemovalTombstones).values({
			itemId: removedId,
			libraryId: library.id,
			sourceIdentityHash: 'fixture',
			firstMissingAt: '2026-08-24T00:00:00Z',
			lastMissingAt: '2026-08-24T00:00:00Z',
			lastCountedAt: '2026-08-24T00:00:00Z',
			consecutiveObservations: 3,
			lastScanId: null,
		});
		await database.db
			.update(libraries)
			.set({ reconciliationStatus: 'removal-approval-required', reconciliationRevision: revision })
			.where(eq(libraries.id, library.id));

		expect(await repository.confirmLibraryRemovals(library.id, revision)).toBe(true);
		const remainingGroups = await database.db
			.select({ id: mediaGroups.id })
			.from(mediaGroups)
			.where(eq(mediaGroups.libraryId, library.id));
		expect(new Set(remainingGroups.map((group) => group.id))).toEqual(new Set([showId, seasonId]));
	});
});
