import { describe, expect, it } from 'vitest';
import { activeCatalogAnchor, breadcrumbTargetTrail } from '@web/catalog-navigation';

const anchors = [
	{ key: 'A', top: 240 },
	{ key: 'B', top: 620 },
	{ key: 'C', top: 1_000 },
];

describe('activeCatalogAnchor', () => {
	it('retains the first anchor before its marker reaches the sticky boundary', () => {
		expect(activeCatalogAnchor(anchors, 180)).toBe('A');
	});

	it('selects the most recent marker at or above the sticky boundary', () => {
		expect(activeCatalogAnchor(anchors, 620)).toBe('B');
		expect(activeCatalogAnchor(anchors, 900)).toBe('B');
	});

	it('selects the final anchor at the document end', () => {
		expect(activeCatalogAnchor(anchors, 180, true)).toBe('C');
	});

	it('returns no anchor for an empty result page', () => {
		expect(activeCatalogAnchor([], 180)).toBe('');
	});
});

describe('breadcrumbTargetTrail', () => {
	const trail = [
		{ title: 'All media' },
		{ id: 'show', title: 'Show' },
		{ id: 'season', title: 'Season 1' },
	];

	it('returns root for the synthetic root breadcrumb', () => {
		expect(breadcrumbTargetTrail(trail, 0)).toEqual([]);
	});

	it('includes the clicked group rather than navigating one level above it', () => {
		expect(breadcrumbTargetTrail(trail, 1)).toEqual([{ id: 'show', title: 'Show' }]);
		expect(breadcrumbTargetTrail(trail, 2)).toEqual([
			{ id: 'show', title: 'Show' },
			{ id: 'season', title: 'Season 1' },
		]);
	});
});
