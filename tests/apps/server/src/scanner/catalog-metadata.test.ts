import { primaryGenreKey } from '@server/scanner/catalog-metadata.js';
import { describe, expect, it } from 'vitest';
import {
	catalogSortTitle,
	normalizeGenres,
	normalizeSearchText,
	titleBucket,
} from '@server/scanner/catalog-metadata.js';

describe('catalog metadata normalization', () => {
	it('collapses documented genre aliases into one stable facet', () => {
		expect(normalizeGenres(['Sci-Fi', 'Science Fiction', 'Drama'])).toEqual([
			{ key: 'science-fiction', name: 'Science Fiction' },
			{ key: 'drama', name: 'Drama' },
		]);
	});

	it('deduplicates conservative spelling aliases and preserves acronym capitalization', () => {
		expect(normalizeGenres([
			'Rom-Com',
			'RomCom',
			'Romantic Comedy',
			'TV-Movie',
			'TVMovie',
			'Television Movie',
			'Reality-TV',
			'Reality Television',
			'Game_Show',
			'GameShow',
			'Talk/Show',
			'TalkShow',
			'Soap Opera',
			'SoapOpera',
			'Docu-Series',
			'Docuseries',
		])).toEqual([
			{ key: 'romantic-comedy', name: 'Romantic Comedy' },
			{ key: 'tv-movie', name: 'TV Movie' },
			{ key: 'reality-tv', name: 'Reality TV' },
			{ key: 'game-show', name: 'Game Show' },
			{ key: 'talk-show', name: 'Talk Show' },
			{ key: 'soap-opera', name: 'Soap Opera' },
			{ key: 'docuseries', name: 'Docuseries' },
		]);
	});

	it('does not merge related genres that have different meanings', () => {
		expect(normalizeGenres([
			'Thriller',
			'Suspense',
			'Animation',
			'Anime',
			'Family',
			'Children',
			'Music',
			'Musical',
		])).toHaveLength(8);
	});

	it('uses folded search values and A-Z title buckets', () => {
		expect(normalizeSearchText('  Chloé   Zhao ')).toBe('chloe zhao');
		expect(titleBucket('Arrival')).toBe('A');
		expect(titleBucket('2001: A Space Odyssey')).toBe('#');
	});

	it('omits leading English articles from fallback sort titles', () => {
		expect(catalogSortTitle('The Matrix')).toBe('Matrix');
		expect(catalogSortTitle('A Quiet Place')).toBe('Quiet Place');
		expect(catalogSortTitle('an Education')).toBe('Education');
		expect(catalogSortTitle('There Will Be Blood')).toBe('There Will Be Blood');
		expect(catalogSortTitle('A')).toBe('A');
	});

	it('sorts an article-only base title before longer titles with the same first word', () => {
		expect([
			'The Matrix Reloaded',
			'The Matrix Resurrections',
			'The Matrix Revolutions',
			'The Matrix',
		].map((title) => catalogSortTitle(title)).sort()).toEqual([
			'Matrix',
			'Matrix Reloaded',
			'Matrix Resurrections',
			'Matrix Revolutions',
		]);
	});

	it('ignores punctuation and symbols in fallback sort titles', () => {
		expect(catalogSortTitle("The 'Burbs")).toBe('Burbs');
		expect(catalogSortTitle('M*A*S*H')).toBe('MASH');
		expect(catalogSortTitle('Spider-Man')).toBe('SpiderMan');
		expect(titleBucket(catalogSortTitle("The 'Burbs"))).toBe('B');
	});

	it('preserves an authored sort title instead of applying article handling', () => {
		expect(catalogSortTitle('The Matrix', 'Custom Matrix Order')).toBe('Custom Matrix Order');
	});
});

it('resolves primary genres without sorting or accepting an override outside the source genres', () => {
	expect(primaryGenreKey({ genres: ['---', 'Sci-Fi', 'Drama', 'science fiction'] })).toBe('science-fiction');
	expect(primaryGenreKey({ genres: ['Comedy', 'Drama'], primaryGenre: 'drama' })).toBe('drama');
	expect(primaryGenreKey({ genres: ['Comedy', 'Drama'], primaryGenre: 'Horror' })).toBe('comedy');
	expect(primaryGenreKey({ genres: [null, '', '---'] })).toBeNull();
	expect(primaryGenreKey({})).toBeNull();
	expect(primaryGenreKey({}, ['Rock', 'Pop'])).toBe('rock');
});
