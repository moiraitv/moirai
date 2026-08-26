/** Named catalog section and the first page that contains it. */
export interface CatalogAnchorPosition {
	key: string;
	top: number;
}

/** Select the section whose start most recently crossed the sticky catalog boundary. */
export function activeCatalogAnchor(
	anchors: CatalogAnchorPosition[],
	boundary: number,
	atDocumentEnd = false,
): string {
	if (anchors.length === 0) {
		return '';
	}

	if (atDocumentEnd) {
		return anchors.at(-1)!.key;
	}

	let active = anchors[0]!.key;
	for (const anchor of anchors) {
		if (anchor.top > boundary) {
			break;
		}

		active = anchor.key;
	}
	return active;
}

/** Browsable catalog ancestor used to restore hierarchical navigation. */
export interface CatalogBreadcrumb {
	id?: string;
	title: string;
}

/** Return persisted group crumbs through the clicked breadcrumb, excluding the synthetic root. */
export function breadcrumbTargetTrail(
	trail: CatalogBreadcrumb[],
	clickedIndex: number,
): CatalogBreadcrumb[] {
	return trail.slice(1, clickedIndex + 1);
}
