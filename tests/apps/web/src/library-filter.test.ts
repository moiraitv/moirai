import { describe, expect, it } from 'vitest';
import {
	catalogProgramQuery,
	catalogProgramItemFilterSummary,
	catalogProgramItemFilter,
	emptyCatalogProgramItemFilter,
	emptyLibraryFilterDraft,
	libraryFilterDraft,
	genreCountLabel,
} from '@web/components/library/library-filter';

describe('shared library query filter controls', () => {
	it('round-trips every persisted filter through date and numeric form fields', () => {
		const filter = catalogProgramItemFilter({
			...emptyLibraryFilterDraft(),
			name: 'Example',
			artist: 'Guest',
			album: 'Live',
			releaseFrom: '1990',
			releaseTo: '2024',
			minimumRating: '7.1',
			minimumUserRating: '8',
			addedFrom: '2026-01-02',
			addedTo: '2026-03-04',
			genres: ['comedy'],
			primaryGenres: ['adventure'],
			excludedGenres: ['drama'],
			genreMatch: 'all',
			actor: 'Actor',
			director: 'Director',
		});

		expect(libraryFilterDraft(filter)).toEqual({
			...emptyLibraryFilterDraft(),
			name: 'Example',
			artist: 'Guest',
			album: 'Live',
			releaseFrom: '1990',
			releaseTo: '2024',
			minimumRating: '7.1',
			minimumUserRating: '8',
			addedFrom: '2026-01-02',
			addedTo: '2026-03-04',
			genres: ['comedy'],
			primaryGenres: ['adventure'],
			excludedGenres: ['drama'],
			genreMatch: 'all',
			actor: 'Actor',
			director: 'Director',
		});
	});

	it('preserves broad search and independent title/music filters when adding all results', () => {
		expect(catalogProgramQuery({
			page: 2, pageSize: 100, sort: 'title', direction: 'asc',
			search: 'Guest', name: 'Song', artist: 'Main', album: 'Live',
		})).toMatchObject({ search: 'Guest', name: 'Song', artist: 'Main', album: 'Live' });
	});

	it('provides an independent empty persisted filter', () => {
		const first = emptyCatalogProgramItemFilter();
		first.genres.push('comedy');
		expect(emptyCatalogProgramItemFilter().genres).toEqual([]);
	});

	it('summarizes applied filters in priority order with compact genre and date ranges', () => {
		const filter = catalogProgramItemFilter({
			...emptyLibraryFilterDraft(),
			name: 'A title that is deliberately much longer than the summary',
			releaseFrom: '1990',
			releaseTo: '2024',
			minimumRating: '7.5',
			minimumUserRating: '',
			addedFrom: '2026-01-02',
			addedTo: '2026-03-04',
			genres: ['comedy', 'science-fiction', 'drama'],
			excludedGenres: ['horror'],
			genreMatch: 'all',
			actor: '',
			director: '',
		});

		expect(catalogProgramItemFilterSummary(filter, new Map([
			['comedy', 'Comedy'],
			['science-fiction', 'Science Fiction'],
			['drama', 'Drama'],
			['horror', 'Horror'],
		]))).toEqual([
			'Title: A title that is deliberatel…',
			'All genres: Comedy, Science Fiction +1',
			'Exclude: Horror',
			'Years: 1990–2024',
			'Rating: 7.5+',
			'Added: 2026-01-02–2026-03-04',
		]);
	});
});

describe('genre count labels', () => {
	it.each([
		[null, '—'], [0, '0'], [1, '1'], [999, '999'],
		[1000, '1.0k'], [1049, '1.0k'], [1050, '1.1k'], [1149, '1.1k'],
		[1150, '1.2k'], [9950, '10.0k'], [100000, '100.0k'],
	] as const)('formats %s as %s', (count, expected) => {
		expect(genreCountLabel(count)).toBe(expected);
	});
});
