import { describe, expect, it } from 'vitest';
import { normalizeGenres, normalizeSearchText, titleBucket } from '@server/scanner/catalog-metadata.js';

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
});
