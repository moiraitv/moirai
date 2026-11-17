import { describe, expect, it } from 'vitest';
import { MAX_METADATA_LIST_ITEMS, MAX_METADATA_PEOPLE_ITEMS, MAX_METADATA_TEXT_LENGTH } from '@moirai/shared';
import { remoteCatalogMetadata } from '@server/media-servers/metadata.js';
import type { RemoteMediaItem } from '@server/media-servers/items.js';

function item(overrides: Partial<RemoteMediaItem> = {}): RemoteMediaItem {
	return {
		id: 'movie', etag: 'unchanged', kind: 'movie', title: 'Movie', sortTitle: null, plot: null, year: null,
		show: null, seasonNumber: null, seasonTitle: null, episodeNumber: null, artists: [], album: null,
		albumId: null, trackNumber: null, genres: [], directors: [], actors: [], externalIds: [], parts: [],
		posterPath: null, landscapePath: null, fanartPath: null, modifiedAt: '2026-01-01T00:00:00Z', ...overrides,
	};
}

describe('remote descriptive metadata normalization', () => {
	it('deduplicates labels and cast without losing spelling, roles, or earliest billing', () => {
		const metadata = remoteCatalogMetadata(item({
			actors: [{ name: ' Renée Actor ', role: null, sortOrder: 5 },
				{ name: 'RENEE ACTOR', role: 'Pilot', sortOrder: 1 }],
			directors: [' Director ', 'DIRECTOR'], genres: [' Drama ', 'DRAMA'],
			metadata: { tags: [' Space ', 'SPACE'], writers: [' Writer ', 'writer'] },
		}));
		expect(metadata).toMatchObject({ actors: [{ name: 'Renée Actor', role: 'Pilot', sortOrder: 1 }],
			directors: ['Director'], genres: ['Drama'], tags: ['Space'], writers: ['Writer'] });
	});

	it('applies existing text, list, and credit limits to provider metadata', () => {
		const cast = Array.from({ length: MAX_METADATA_PEOPLE_ITEMS + 1 }, (_, index) => ({ name: `Actor ${index}`, role: null, sortOrder: index }));
		const tags = Array.from({ length: MAX_METADATA_LIST_ITEMS + 1 }, (_, index) => `Tag ${index}`);
		const metadata = remoteCatalogMetadata(item({ actors: cast, metadata: { originalTitle: 'x'.repeat(MAX_METADATA_TEXT_LENGTH + 1), tags } }));
		expect(metadata.originalTitle).toHaveLength(MAX_METADATA_TEXT_LENGTH);
		expect(metadata.tags).toEqual(tags.slice(0, MAX_METADATA_LIST_ITEMS));
		expect(metadata.actors).toHaveLength(MAX_METADATA_PEOPLE_ITEMS);
	});

	it.each([0, 10])('preserves a valid boundary rating of %s', value => {
		expect(remoteCatalogMetadata(item({ metadata: { rating: value, userRating: value } })))
			.toMatchObject({ rating: value, userRating: value });
	});

	it.each([-1, 10.1, NaN, Infinity])('discards invalid rating %s without inventing a value', value => {
		expect(remoteCatalogMetadata(item({ metadata: { rating: value, userRating: value } })))
			.toMatchObject({ rating: null, userRating: null });
	});

	it('normalizes full release timestamps and rejects impossible calendar dates', () => {
		expect(remoteCatalogMetadata(item({ metadata: { releaseDate: '2020-02-29T08:00:00+02:00' } })).releaseDate).toBe('2020-02-29');
		expect(remoteCatalogMetadata(item({ metadata: { releaseDate: '2021-02-29' } })).releaseDate).toBeNull();
		expect(remoteCatalogMetadata(item()).releaseDate).toBeNull();
	});
});
