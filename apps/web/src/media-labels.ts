import type { MediaGroup, MediaItem } from '@moirai/shared';

/** Format a release year while preserving the unknown-year fallback. */
function displayYear(year: number | null): string {
	return year !== null && year > 0 ? String(year) : '';
}

/** Build the compact card label from fields meaningful to the configured library type. */
export function mediaItemSubtitle(typeKey: string, item: MediaItem): string {
	if (typeKey === 'shows') {
		if (item.seasonNumber !== null && item.episodeNumber !== null) {
			return 'S' + item.seasonNumber + 'E' + item.episodeNumber
				+ (item.episodeEndNumber != null ? '–E' + item.episodeEndNumber : '');
		}

		if (item.seasonNumber !== null) {
			return 'Season ' + item.seasonNumber;
		}

		if (item.episodeNumber !== null) {
			return 'Episode ' + item.episodeNumber;
		}

		return '';
	}

	if (typeKey === 'music-videos') {
		const artists = Array.isArray(item.metadata.artists)
			? item.metadata.artists.filter((artist): artist is string => typeof artist === 'string')
			: [];
		return [...artists, displayYear(item.year)].filter(Boolean).join(' · ');
	}

	return [displayYear(item.year), item.edition].filter(Boolean).join(' · ');
}

/** Show series use their indexed release span; other group types use a single year. */
export function mediaGroupSubtitle(typeKey: string, group: MediaGroup): string {
	if (typeKey !== 'shows' || group.kind !== 'show') {
		return displayYear(group.year);
	}

	const start = displayYear(group.year);
	const end = displayYear(group.yearEnd);
	if (!start) {
		return end;
	}

	return end && end !== start ? start + '–' + end : start;
}
