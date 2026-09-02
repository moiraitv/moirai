import type { MediaBrowseEntry } from '@moirai/shared';

/** Minimum card width used by the desktop catalog grid. */
export const catalogCardMinimumWidth = 170;
/** Horizontal gap between catalog cards. */
export const catalogCardColumnGap = 14;
/** Viewport width where the catalog switches to its fixed mobile grid. */
export const catalogMobileBreakpoint = 700;
/** Column count retained by the compact catalog layout. */
export const catalogMobileColumnCount = 2;

/** One media card and its index in the paginated catalog response. */
export interface CatalogVirtualCard {
	entry: MediaBrowseEntry;
	entryIndex: number;
}

/** One virtualized full-width heading or responsive row of media cards. */
export type CatalogVirtualRow
	= | {
		key: string;
		kind: 'heading';
		label: string;
		anchorKeys: string[];
		cards: [];
	}
	| {
		key: string;
		kind: 'cards';
		label: null;
		anchorKeys: string[];
		cards: CatalogVirtualCard[];
	};

/** Derive the responsive number of columns represented by each virtual row. */
export function catalogColumnCount(containerWidth: number, viewportWidth: number): number {
	if (viewportWidth <= catalogMobileBreakpoint) {
		return catalogMobileColumnCount;
	}

	return Math.max(
		1,
		Math.floor(
			(containerWidth + catalogCardColumnGap)
			/ (catalogCardMinimumWidth + catalogCardColumnGap),
		),
	);
}

/** Group paginated catalog entries into measurable rows without losing section anchors. */
export function buildCatalogVirtualRows(
	entries: MediaBrowseEntry[],
	columnCount: number,
): CatalogVirtualRow[] {
	const rows: CatalogVirtualRow[] = [];
	let cards: CatalogVirtualCard[] = [];
	let anchorKeys: string[] = [];

	/** Finish the current card row before a heading or a full row begins. */
	function flushCards(): void {
		if (cards.length === 0) {
			return;
		}

		rows.push({
			key: `cards:${cards[0]!.entry.key}`,
			kind: 'cards',
			label: null,
			anchorKeys,
			cards,
		});
		cards = [];
		anchorKeys = [];
	}

	for (const [entryIndex, entry] of entries.entries()) {
		const startsSection
			= Boolean(entry.navigationKey)
				&& entry.navigationKey !== entries[entryIndex - 1]?.navigationKey;

		if (startsSection && entry.sectionLabel) {
			flushCards();
			rows.push({
				key: `heading:${entry.navigationKey}:${entry.key}`,
				kind: 'heading',
				label: entry.sectionLabel,
				anchorKeys: [entry.navigationKey],
				cards: [],
			});
		}
		else if (startsSection) {
			anchorKeys.push(entry.navigationKey);
		}

		cards.push({ entry, entryIndex });
		if (cards.length >= Math.max(1, columnCount)) {
			flushCards();
		}
	}

	flushCards();
	return rows;
}

/** Find the virtual row that owns a catalog navigation anchor. */
export function catalogAnchorRowIndex(rows: CatalogVirtualRow[], key: string): number {
	return rows.findIndex((row) => row.anchorKeys.includes(key));
}

/** Project virtual row offsets into viewport positions used by active-anchor selection. */
export function catalogVirtualAnchorPositions(
	rows: CatalogVirtualRow[],
	rowStarts: number[],
	scrollTop: number,
): Array<{ key: string; top: number }> {
	return rows.flatMap((row, index) => row.anchorKeys.map((key) => ({
		key,
		top: (rowStarts[index] ?? 0) - scrollTop,
	})));
}
