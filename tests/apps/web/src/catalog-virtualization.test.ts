import { describe, expect, it } from 'vitest';
import type { MediaBrowseEntry } from '@moirai/shared';
import {
	buildCatalogVirtualRows,
	catalogAnchorRowIndex,
	catalogColumnCount,
	catalogVirtualAnchorPositions,
} from '@web/catalog-virtualization';

/** Create a small catalog entry carrying only virtualization-relevant values. */
function entry(
	key: string,
	navigationKey: string,
	sectionLabel: string | null = null,
): MediaBrowseEntry {
	return {
		key,
		kind: 'item',
		navigationKey,
		sectionKey: null,
		sectionLabel,
		item: null,
		group: null,
	};
}

describe('catalog virtualization', () => {
	it('derives desktop columns from the available grid width and preserves mobile columns', () => {
		expect(catalogColumnCount(722, 1_200)).toBe(4);
		expect(catalogColumnCount(320, 700)).toBe(2);
	});

	it('keeps headings full width and assigns unlabelled anchors to their card rows', () => {
		const rows = buildCatalogVirtualRows([
			entry('drama-1', 'Drama', 'Drama'),
			entry('drama-2', 'Drama'),
			entry('comedy-1', 'Comedy', 'Comedy'),
			entry('comedy-2', 'Comedy'),
		], 2);

		expect(rows.map((row) => ({
			kind: row.kind,
			label: row.label,
			anchors: row.anchorKeys,
			cards: row.cards.map((card) => card.entry.key),
		}))).toEqual([
			{ kind: 'heading', label: 'Drama', anchors: ['Drama'], cards: [] },
			{ kind: 'cards', label: null, anchors: [], cards: ['drama-1', 'drama-2'] },
			{ kind: 'heading', label: 'Comedy', anchors: ['Comedy'], cards: [] },
			{ kind: 'cards', label: null, anchors: [], cards: ['comedy-1', 'comedy-2'] },
		]);

		const titleRows = buildCatalogVirtualRows([
			entry('alpha', 'A'),
			entry('beta', 'B'),
		], 2);
		expect(titleRows[0]?.anchorKeys).toEqual(['A', 'B']);
		expect(catalogAnchorRowIndex(titleRows, 'B')).toBe(0);
	});

	it('projects anchors from virtual measurements even when their rows are not rendered', () => {
		const rows = buildCatalogVirtualRows([
			entry('alpha', 'A'),
			entry('beta', 'B'),
			entry('charlie', 'C'),
		], 1);

		expect(catalogVirtualAnchorPositions(rows, [500, 800, 1_100], 650)).toEqual([
			{ key: 'A', top: -150 },
			{ key: 'B', top: 150 },
			{ key: 'C', top: 450 },
		]);
	});
});
