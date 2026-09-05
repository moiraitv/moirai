import { describe, expect, it } from 'vitest';
import {
	catalogProgramItemFilterSummary,
	catalogProgramItemFilter,
	emptyCatalogProgramItemFilter,
	libraryFilterDraft,
} from '@web/components/library/library-filter';

describe('shared library query filter controls', () => {
	it('round-trips every persisted filter through date and numeric form fields', () => {
		const filter = catalogProgramItemFilter({
			name: 'Example',
			releaseFrom: '1990',
			releaseTo: '2024',
			minimumRating: '7.1',
			minimumUserRating: '8',
			addedFrom: '2026-01-02',
			addedTo: '2026-03-04',
			genres: ['comedy'],
			excludedGenres: ['drama'],
			genreMatch: 'all',
			actor: 'Actor',
			director: 'Director',
		});

		expect(libraryFilterDraft(filter)).toEqual({
			name: 'Example',
			releaseFrom: '1990',
			releaseTo: '2024',
			minimumRating: '7.1',
			minimumUserRating: '8',
			addedFrom: '2026-01-02',
			addedTo: '2026-03-04',
			genres: ['comedy'],
			excludedGenres: ['drama'],
			genreMatch: 'all',
			actor: 'Actor',
			director: 'Director',
		});
	});

	it('provides an independent empty persisted filter', () => {
		const first = emptyCatalogProgramItemFilter();
		first.genres.push('comedy');
		expect(emptyCatalogProgramItemFilter().genres).toEqual([]);
	});

	it('summarizes applied filters in priority order with compact genre and date ranges', () => {
		const filter = catalogProgramItemFilter({
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
