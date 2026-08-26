import { describe, expect, it } from 'vitest';
import type { SchedulingCatalog, SchedulingProgram } from '@moirai/shared';
import { schedulingProgramStatuses } from '@server/scheduling/status.js';

const program: SchedulingProgram = {
	id: '00000000-0000-4000-8000-000000000001',
	name: 'Movies',
	config: {
		type: 'content',
		source: {
			type: 'library-query',
			libraryId: '00000000-0000-4000-8000-000000000002',
			kinds: ['movie'],
			genres: [],
		},
		strategy: { type: 'sequential' },
	},
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

function catalog(availability: 'available' | 'unconfirmed'): SchedulingCatalog {
	return {
		media: [
			{
				id: '00000000-0000-4000-8000-000000000003',
				libraryId:
          program.config.type === 'content' && program.config.source.type === 'library-query'
          	? program.config.source.libraryId
          	: '',
				groupId: null,
				kind: 'movie',
				title: 'Film',
				sortTitle: 'Film',
				playbackPath: '/media/film.mkv',
				durationSeconds: 90 * 60,
				seasonNumber: null,
				episodeNumber: null,
				genres: [],
				genreNames: [],
				plot: null,
				year: null,
				artworkUrl: null,
				availability,
			},
		],
		groupParents: {},
		groupTitles: {},
		libraryAvailability: {
			'00000000-0000-4000-8000-000000000002': 'available',
		},
		libraryNames: { '00000000-0000-4000-8000-000000000002': 'Movies' },
	};
}

describe('scheduling program status', () => {
	it('distinguishes a temporarily unavailable item from a missing source reference', () => {
		expect(schedulingProgramStatuses([program], catalog('unconfirmed'))[0]).toMatchObject({
			health: 'unavailable',
			indexedItemCount: 1,
			availableItemCount: 0,
		});
		const missingCatalog = catalog('available');
		missingCatalog.libraryAvailability = {};
		missingCatalog.libraryNames = {};
		expect(schedulingProgramStatuses([program], missingCatalog)[0]?.health).toBe('missing');
	});

	it('reports a partially missing explicit collection as degraded', () => {
		const fixture = catalog('available');
		const collection: SchedulingProgram = {
			...program,
			config: {
				type: 'content',
				source: {
					type: 'collection',
					libraryId: '00000000-0000-4000-8000-000000000002',
					itemIds: ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004'],
				},
				strategy: { type: 'sequential' },
			},
		};

		expect(schedulingProgramStatuses([collection], fixture)[0]).toMatchObject({
			health: 'degraded',
			sourceLabel: '2 selected from Movies',
			indexedItemCount: 1,
			availableItemCount: 1,
		});
	});

	it('summarizes selected season groups and reports missing selections as degraded', () => {
		const fixture = catalog('available');
		const showId = '00000000-0000-4000-8000-000000000010';
		const seasonId = '00000000-0000-4000-8000-000000000011';
		const missingSeasonId = '00000000-0000-4000-8000-000000000012';
		fixture.media[0]!.groupId = seasonId;
		fixture.media[0]!.kind = 'episode';
		fixture.media[0]!.seasonNumber = 1;
		fixture.media[0]!.episodeNumber = 1;
		fixture.groupParents = { [showId]: null, [seasonId]: showId };
		fixture.groupTitles = { [showId]: 'Series', [seasonId]: 'Season 1' };
		const selectedSeasons: SchedulingProgram = {
			...program,
			config: {
				type: 'content',
				source: {
					type: 'group-collection',
					libraryId: '00000000-0000-4000-8000-000000000002',
					groupIds: [seasonId, missingSeasonId],
				},
				strategy: { type: 'sequential' },
			},
		};

		expect(schedulingProgramStatuses([selectedSeasons], fixture)[0]).toMatchObject({
			health: 'degraded',
			sourceLabel: '2 selected media groups from Movies',
			indexedItemCount: 1,
			availableItemCount: 1,
		});
	});
});
