import { describe, expect, it } from 'vitest';
import type { SchedulingCatalog, SchedulingProgram, SelectedMediaSort } from '@moirai/shared';
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

	it('includes unavailable indexed matches in bounded program previews', () => {
		const fixture = catalog('unconfirmed');
		fixture.media = Array.from({ length: 14 }, (_, index) => ({
			...fixture.media[0]!,
			id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
			title: `Film ${index + 1}`,
		}));

		const status = schedulingProgramStatuses([program], fixture)[0]!;
		expect(status.previewItems).toHaveLength(12);
		expect(status.previewItems[0]).toMatchObject({
			libraryId: '00000000-0000-4000-8000-000000000002',
			title: 'Film 1',
			availability: 'unconfirmed',
		});
	});

	it('sorts and limits a dynamic query before reporting its playable set', () => {
		const fixture = catalog('available');
		fixture.media = ['Alpha', 'Middle', 'Zulu'].map((title, index) => ({
			...fixture.media[0]!,
			id: `00000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`,
			title,
			sortTitle: title,
		}));
		const limited: SchedulingProgram = {
			...program,
			config: {
				type: 'content',
				source: {
					type: 'library-query',
					libraryId: '00000000-0000-4000-8000-000000000002',
					kinds: ['movie'],
					genres: [],
					sort: { type: 'name', direction: 'desc' },
					itemLimit: 2,
				},
				strategy: { type: 'sequential' },
			},
		};

		const status = schedulingProgramStatuses([limited], fixture)[0]!;
		expect(status.indexedItemCount).toBe(2);
		expect(status.previewItems.map((item) => item.title)).toEqual(['Zulu', 'Middle']);
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
					sort: { type: 'date-added', direction: 'asc' },
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

	it('recomputes selected-media previews in the configured program order', () => {
		const fixture = catalog('available');
		const zuluId = '00000000-0000-4000-8000-000000000003';
		const alphaId = '00000000-0000-4000-8000-000000000004';
		const betaId = '00000000-0000-4000-8000-000000000005';
		fixture.media = [
			{ ...fixture.media[0]!, id: zuluId, title: 'The Zulu', sortTitle: 'Zulu', year: 2000, releaseDate: '2000-06-01' },
			{ ...fixture.media[0]!, id: alphaId, title: 'Alpha', sortTitle: 'Alpha', year: 1990, releaseDate: '1990-04-01' },
			{ ...fixture.media[0]!, id: betaId, title: 'Beta', sortTitle: 'Beta', year: null, releaseDate: null },
		];
		const previewTitles = (sort: SelectedMediaSort): string[] => schedulingProgramStatuses([{
			...program,
			config: {
				type: 'content',
				source: {
					type: 'collection',
					libraryId: '00000000-0000-4000-8000-000000000002',
					itemIds: [zuluId, alphaId, betaId],
					additionBatches: [[zuluId, alphaId], [betaId]],
					sort,
				},
				strategy: { type: 'sequential' },
			},
		}], fixture)[0]!.previewItems.map((item) => item.title);

		expect(previewTitles({ type: 'date-added', direction: 'asc' }))
			.toEqual(['The Zulu', 'Alpha', 'Beta']);
		expect(previewTitles({ type: 'date-added', direction: 'desc' }))
			.toEqual(['Beta', 'The Zulu', 'Alpha']);
		expect(previewTitles({ type: 'name', direction: 'asc' }))
			.toEqual(['Alpha', 'Beta', 'The Zulu']);
		expect(previewTitles({ type: 'release-date', direction: 'desc' }))
			.toEqual(['The Zulu', 'Alpha', 'Beta']);
		expect(previewTitles({ type: 'manual', itemIds: [betaId, alphaId, zuluId] }))
			.toEqual(['Beta', 'Alpha', 'The Zulu']);
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
