import { describe, expect, it } from 'vitest';
import {
	quickChannelQueryPreviewRequestSchema,
	quickChannelSetupCreateSchema,
} from '@moirai/shared';

const libraryId = '00000000-0000-4000-8000-000000000001';

/** Build the smallest valid Quick Setup request for schema tests. */
function request() {
	return {
		scenario: 'movies' as const,
		libraryId,
		programName: 'Movie Programming',
		source: { type: 'library-query' as const, genres: [] },
		strategy: { type: 'shuffle' as const, seed: '' },
		channel: { number: '1', name: 'Movie Channel', group: 'Movies' },
	};
}

describe('quick channel setup contract', () => {
	it('accepts each scenario with its supported source choices', () => {
		expect(quickChannelSetupCreateSchema.safeParse(request()).success).toBe(true);
		expect(quickChannelSetupCreateSchema.safeParse({
			...request(),
			scenario: 'shows',
			source: {
				type: 'group-collection',
				groupIds: ['00000000-0000-4000-8000-000000000002'],
			},
		}).success).toBe(true);
		expect(quickChannelSetupCreateSchema.safeParse({
			...request(),
			scenario: 'music-videos',
			source: {
				type: 'collection',
				itemIds: ['00000000-0000-4000-8000-000000000003'],
			},
		}).success).toBe(true);
	});

	it('rejects show groups for non-show scenarios and unsafe channel numbers', () => {
		expect(quickChannelSetupCreateSchema.safeParse({
			...request(),
			source: {
				type: 'group-collection',
				groupIds: ['00000000-0000-4000-8000-000000000002'],
			},
		}).success).toBe(false);
		expect(quickChannelSetupCreateSchema.safeParse({
			...request(),
			channel: { ...request().channel, number: '..' },
		}).success).toBe(false);
		expect(quickChannelSetupCreateSchema.safeParse({
			...request(),
			source: { ...request().source, itemLimit: 0 },
		}).success).toBe(false);
	});

	it('normalizes genre filters used by live query previews', () => {
		expect(quickChannelQueryPreviewRequestSchema.parse({
			scenario: 'shows',
			libraryId,
			genres: ['Science Fiction', 'science-fiction', 'Sport', ' SPORTS '],
		})).toMatchObject({
			genres: ['science-fiction', 'sports'],
			excludedGenres: [],
			genreMatch: 'all',
		});
	});
});
