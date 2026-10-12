/** Hierarchy and episode metadata shared by selection reviews and scheduling. */
export interface EpisodeOrderItem {
	showId?: string | null;
	showSortTitle?: string | null;
	seasonNumber?: number | null;
	episodeNumber?: number | null;
}

/** Compare episode numbers while keeping absent metadata last in either direction. */
function compareNumber(left: number | null | undefined, right: number | null | undefined, direction: 'asc' | 'desc'): number {
	if (left == null || right == null) {
		return left == null ? right == null ? 0 : 1 : -1;
	}

	return (left - right) * (direction === 'asc' ? 1 : -1);
}

/** Keep shows together alphabetically, then order episodes numerically within each show. */
export function compareEpisodeOrder(left: EpisodeOrderItem, right: EpisodeOrderItem, direction: 'asc' | 'desc'): number {
	const leftKnown = Boolean(left.showId && left.showSortTitle);
	const rightKnown = Boolean(right.showId && right.showSortTitle);
	if (leftKnown !== rightKnown) {
		return leftKnown ? -1 : 1;
	}
	if (leftKnown && rightKnown) {
		const show = left.showSortTitle!.localeCompare(right.showSortTitle!, 'en-US', { sensitivity: 'base' })
			|| left.showId!.localeCompare(right.showId!);
		if (show !== 0) {
			return show;
		}
	}

	return compareNumber(left.seasonNumber, right.seasonNumber, direction)
		|| compareNumber(left.episodeNumber, right.episodeNumber, direction);
}
