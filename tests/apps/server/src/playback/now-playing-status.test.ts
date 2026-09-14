import { describe, expect, it } from 'vitest';
import type { MaterializedSegmentRecord } from '@server/repository/contracts.js';
import { nowPlayingStatus } from '@server/playback/now-playing-status.js';

function record(media: Partial<NonNullable<MaterializedSegmentRecord['mediaSnapshot']>> | null): MaterializedSegmentRecord {
	return {
		segment: { title: 'Original title', start: '2026-09-14T01:00:00Z', finish: '2026-09-14T02:00:00Z' },
		mediaSnapshot: media,
	} as MaterializedSegmentRecord;
}

describe('now-playing content labels', () => {
	it('preserves movie and fallback titles and timing', () => {
		expect(nowPlayingStatus(record({ kind: 'movie', title: 'Movie title' }))?.title).toBe('Original title');
		expect(nowPlayingStatus(record(null))).toEqual({ title: 'Original title', artworkUrl: null, startedAt: '2026-09-14T01:00:00Z', finishesAt: '2026-09-14T02:00:00Z' });
		expect(nowPlayingStatus(undefined)).toBeNull();
	});

	it('includes series, season, episode range, and episode title', () => {
		expect(nowPlayingStatus(record({ kind: 'episode', seriesTitle: 'Space Station', seasonNumber: 2, episodeNumber: 5, title: 'First Contact' }))?.title)
			.toBe('Space Station · S2E5 · First Contact');
		expect(nowPlayingStatus(record({ kind: 'episode', seriesTitle: 'Space Station', seasonNumber: 0, episodeNumber: 0, episodeEndNumber: 2, title: 'Specials' }))?.title)
			.toBe('Space Station · S0E0–E2 · Specials');
	});

	it('omits missing episode facts without inventing labels', () => {
		expect(nowPlayingStatus(record({ kind: 'episode', title: 'Episode', seasonNumber: null, episodeNumber: null }))?.title).toBe('Episode');
		expect(nowPlayingStatus(record({ kind: 'episode', title: 'Episode', seasonNumber: null, episodeNumber: 3 }))?.title).toBe('E3 · Episode');
	});

	it('includes artist credits and the song, with a title-only fallback', () => {
		expect(nowPlayingStatus(record({ kind: 'music-video', title: 'Song', artists: [' Artist ', 'Guest', 'Artist', ''] }))?.title).toBe('Artist, Guest · Song');
		expect(nowPlayingStatus(record({ kind: 'music-video', title: 'Song' }))?.title).toBe('Song');
	});
});
