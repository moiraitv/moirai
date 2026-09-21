import { describe, expect, it } from 'vitest';
import { programConfigSchema, type SchedulableMedia } from '@moirai/shared';
import {
	compareLibraryQueryMedia,
	libraryQueryStateSource,
	mediaMatchesLibraryQuery,
} from '@server/scheduling/content-query.js';

const libraryId = '00000000-0000-4000-8000-000000000001';
const media: SchedulableMedia = {
	id: '00000000-0000-4000-8000-000000000002',
	libraryId,
	groupId: null,
	kind: 'movie',
	title: 'The Example Film',
	sortTitle: 'Example Film',
	playbackPath: '/media/example.mkv',
	durationSeconds: 7_200,
	seasonNumber: null,
	episodeNumber: null,
	genres: ['comedy', 'science-fiction'],
	genreNames: ['Comedy', 'Science Fiction'],
	plot: null,
	year: 2024,
	releaseDate: '2024-04-02',
	dateAddedAt: '2026-06-15T07:00:00.000Z',
	rating: 8.1,
	userRating: 7.5,
	actors: ['Renée Example'],
	directors: ['Morgan Director'],
	artworkUrl: null,
	availability: 'available',
};

/** Build a fully normalized dynamic source through the public persistence contract. */
function source(overrides: Record<string, unknown> = {}) {
	const config = programConfigSchema.parse({
		type: 'content',
		source: {
			type: 'library-query',
			libraryId,
			kinds: ['movie'],
			genres: [],
			...overrides,
		},
		strategy: { type: 'sequential' },
	});
	if (config.type !== 'content' || config.source.type !== 'library-query') {
		throw new Error('Expected a library query');
	}
	return config.source;
}

describe('dynamic scheduling content filters', () => {
	it('omits neutral state defaults but preserves meaningful filters and ordering', () => {
		const baseline = libraryQueryStateSource(source());
		expect(libraryQueryStateSource(source({
			name: '', actor: '', director: '', releaseYearFrom: null, releaseYearTo: null,
			minimumRating: null, minimumUserRating: null, addedFrom: null, addedBefore: null,
			excludedGenres: [], genreMatch: 'all', itemLimit: null,
			sort: { type: 'name', direction: 'asc' },
		}))).toEqual(baseline);
		expect(libraryQueryStateSource(source({
			minimumRating: 0, genreMatch: 'any', itemLimit: 1,
			sort: { type: 'name', direction: 'desc' },
		}))).toMatchObject({
			minimumRating: 0, genreMatch: 'any', itemLimit: 1,
			sort: { type: 'name', direction: 'desc' },
		});
	});

	it('compares offset boundaries as instants with an inclusive start and exclusive end', () => {
		expect(mediaMatchesLibraryQuery(media, source({
			addedFrom: '2026-06-15T09:00:00+02:00',
			addedBefore: '2026-06-15T03:01:00-04:00',
		}))).toBe(true);
		expect(mediaMatchesLibraryQuery(media, source({
			addedFrom: '2026-06-15T03:01:00-04:00',
		}))).toBe(false);
		expect(mediaMatchesLibraryQuery(media, source({
			addedBefore: '2026-06-15T09:00:00+02:00',
		}))).toBe(false);
	});

	it('matches every Filter Library field with inclusive and exclusive bounds', () => {
		expect(mediaMatchesLibraryQuery(media, source({
			name: 'example',
			releaseYearFrom: 2020,
			releaseYearTo: 2024,
			minimumRating: 8,
			minimumUserRating: 7,
			addedFrom: '2026-06-01T07:00:00.000Z',
			addedBefore: '2026-07-01T07:00:00.000Z',
			genres: ['Comedy', 'Science Fiction'],
			excludedGenres: ['drama'],
			genreMatch: 'all',
			actor: 'renee',
			director: 'director',
		}))).toBe(true);

		expect(mediaMatchesLibraryQuery(media, source({ minimumRating: 8.2 }))).toBe(false);
		expect(mediaMatchesLibraryQuery(media, source({ addedBefore: media.dateAddedAt })))
			.toBe(false);
		expect(mediaMatchesLibraryQuery(media, source({ excludedGenres: ['comedy'] })))
			.toBe(false);
		expect(mediaMatchesLibraryQuery(media, source({ actor: 'missing' }))).toBe(false);
	});

	it('supports Match any while defaulting legacy sources to Match all without exclusions', () => {
		expect(mediaMatchesLibraryQuery(media, source({
			genres: ['drama', 'comedy'],
			genreMatch: 'any',
		}))).toBe(true);
		expect(mediaMatchesLibraryQuery(media, source({
			genres: ['comedy', 'drama'],
		}))).toBe(false);
	});

	it('orders query matches by title, indexed date, or release date with missing dates last', () => {
		const older = {
			...media,
			id: '00000000-0000-4000-8000-000000000003',
			title: 'Zulu',
			sortTitle: 'Zulu',
			releaseDate: '1999-01-01',
			dateAddedAt: '2025-01-01T00:00:00.000Z',
		};
		const missingDates = {
			...media,
			id: '00000000-0000-4000-8000-000000000004',
			title: 'Missing',
			sortTitle: 'Missing',
			year: null,
			releaseDate: null,
			dateAddedAt: null,
		};
		const items = [older, missingDates, media];

		expect([...items].sort((left, right) => compareLibraryQueryMedia(left, right, {
			type: 'name', direction: 'asc',
		})).map((item) => item.title)).toEqual(['The Example Film', 'Missing', 'Zulu']);
		expect([...items].sort((left, right) => compareLibraryQueryMedia(left, right, {
			type: 'date-added', direction: 'desc',
		})).map((item) => item.title)).toEqual(['The Example Film', 'Zulu', 'Missing']);
		expect([...items].sort((left, right) => compareLibraryQueryMedia(left, right, {
			type: 'release-date', direction: 'asc',
		})).map((item) => item.title)).toEqual(['Zulu', 'The Example Film', 'Missing']);
	});
});

describe('duration bounds in scheduling', () => {
	it.each([
		[null, null, null, true], [0, null, null, false], [null, 60, null, false],
		[60, null, 59.999, false], [60, null, 60, true],
		[null, 60, 60, true], [null, 60, 60.001, false],
		[60, 60, 60, true], [0, 0, 0, true],
	])('matches inclusive %s–%s bounds against %s seconds', (minimumDurationSeconds, maximumDurationSeconds, durationSeconds, expected) => {
		expect(mediaMatchesLibraryQuery({ ...media, durationSeconds }, source({ minimumDurationSeconds, maximumDurationSeconds }))).toBe(expected);
	});
});
