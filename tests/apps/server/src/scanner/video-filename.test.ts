import { describe, expect, it } from 'vitest';
import {
	parseCollectionFolder,
	parseVideoFilename,
} from '@server/scanner/video-filename.js';

describe('parseVideoFilename', () => {
	it.each([
		['Series/Season 01/Series.S01E02.Title.mkv', 1, 2, null, 'Title'],
		['Series/Season 03/Series.S03E17-E18.Double.mkv', 3, 17, 18, 'Double'],
		['Series/Series.1x02.Legacy.mkv', 1, 2, null, 'Legacy'],
		['Series/Series.season-1.episode-2.Words.mkv', 1, 2, null, 'Words'],
		['Series/Season 01/show-name_s01.e02.mkv', 1, 2, null, 'Episode 2'],
		['Series/Season 03/Episode 05 - Folder Title.mkv', 3, 5, null, 'Folder Title'],
		['Series/Any Folder/3.06.Dotted Title.mkv', 3, 6, null, 'Dotted Title'],
		['Series/Season 03/3-07-Paired Title.mkv', 3, 7, null, 'Paired Title'],
	])('parses documented episode form %s', (filename, season, episode, end, title) => {
		expect(parseVideoFilename(filename, 'shows')).toMatchObject({
			seasonNumber: season,
			episodeNumber: episode,
			episodeEndNumber: end,
			title,
		});
	});

	it('retains movie disambiguation, edition, and multipart fields', () => {
		expect(parseVideoFilename(
			'Movie Name (2024) {tmdb-1234} {edition-Extended Cut}-part2.mkv',
			'movies',
		)).toMatchObject({
			title: 'Movie Name',
			year: 2024,
			edition: 'Extended Cut',
			externalIds: [{ provider: 'tmdb', value: '1234', isDefault: true }],
			part: { kind: 'part', number: 2 },
			logicalStem: 'Movie Name (2024) {tmdb-1234} {edition-Extended Cut}',
		});
	});

	it.each(['Disc 2', 'part1', 'CD_2', 'DVD-2', 'disk.2', ' - Disc 2', '._-part2', '\t-disc2'])(
		'keeps %s standalone when the multipart marker has no name prefix',
		(stem) => {
			expect(parseVideoFilename(`Artist/Album/${stem}.mp4`, 'music-videos')).toMatchObject({
				part: null,
				logicalStem: stem,
			});
		},
	);

	it.each(['disc', 'part', 'cd', 'dvd', 'disk'])(
		'retains named multipart files using the %s suffix',
		(kind) => {
			expect(parseVideoFilename(`Movie Name - ${kind}2.mp4`, 'movies')).toMatchObject({
				title: 'Movie Name',
				logicalStem: 'Movie Name',
				part: { kind, number: 2 },
			});
		},
	);

	it.each([
		['Movie Name - 1080p.mkv', '1080p'],
		["Movie Name - Director's Cut.mkv", "Director's Cut"],
		['Movie Name - 3D.HSBS.mkv', '3D.HSBS'],
	])('recognizes legacy movie edition form %s', (filename, edition) => {
		expect(parseVideoFilename(filename, 'movies')).toMatchObject({
			title: 'Movie Name',
			edition,
		});
	});

	it('parses music-video track numbers without treating other leading digits as episodes', () => {
		expect(parseVideoFilename('Artist/Album/04 - Track Title.mkv', 'music-videos')).toMatchObject({
			title: 'Track Title',
			trackNumber: 4,
			seasonNumber: null,
			episodeNumber: null,
		});
	});
});

describe('parseCollectionFolder', () => {
	it('removes show year and provider tags while retaining them as typed metadata', () => {
		expect(parseCollectionFolder('Show Name (2020) {tvdb-42}')).toEqual({
			title: 'Show Name',
			year: 2020,
			externalIds: [{ provider: 'tvdb', value: '42', isDefault: true }],
		});
	});
});
