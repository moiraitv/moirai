import { describe, expect, it } from 'vitest';
import type { MediaGroup, MediaItem } from '@moirai/shared';
import { mediaGroupSubtitle, mediaItemSubtitle } from '@web/media-labels';

const item = {
	year: 1999,
	seasonNumber: 0,
	episodeNumber: 0,
	metadata: {},
} as MediaItem;

describe('media card labels', () => {
	it('shows only the release year for movies even if legacy episode values exist', () => {
		expect(mediaItemSubtitle('movies', item)).toBe(String(item.year));
	});

	it('shows episode coordinates instead of release year for show episodes', () => {
		expect(mediaItemSubtitle('shows', { ...item, seasonNumber: 2, episodeNumber: 3 })).toBe('S2E3');
	});

	it('shows the indexed year range for a series', () => {
		const group = { kind: 'show', year: 2017, yearEnd: 2024 } as MediaGroup;
		expect(mediaGroupSubtitle('shows', group)).toBe(String(group.year) + '–' + group.yearEnd);
	});
});

it('labels music hierarchy cards with albums and songs', () => {
	expect(mediaGroupSubtitle('music-videos', { kind: 'artist', year: null, childCount: 2 } as MediaGroup)).toBe('2 albums');
	expect(mediaGroupSubtitle('music-videos', { kind: 'album', year: 2020, childCount: 1 } as MediaGroup)).toBe('2020 · 1 song');
});
