import type { SelectedMediaSort } from '@moirai/shared';

/** Describe the complete configured playback order rather than an ambiguous sort field. */
export function playbackOrderLabel(sort: SelectedMediaSort, ai = false): string {
	if (sort.type === 'manual') {
		return 'Manual';
	}

	const labels = { 'date-added': ai ? 'Indexed date' : 'Date Added to Program', name: ai ? 'Title' : 'Name', 'release-date': 'Release Date', episode: 'Season / episode' };
	const directions = sort.type === 'name' ? ['A–Z', 'Z–A'] : sort.type === 'episode' ? ['First to last', 'Last to first'] : ['Oldest First', 'Newest First'];
	return `${labels[sort.type]} · ${directions[sort.direction === 'asc' ? 0 : 1]}`;
}
