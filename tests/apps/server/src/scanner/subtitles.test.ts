import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	discoverSidecarSubtitles,
	embeddedSubtitleTracks,
} from '@server/scanner/subtitles.js';
import type { MediaProbeResult } from '@server/media/media-probe.js';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('discoverSidecarSubtitles', () => {
	it('captures logical, part-scoped, and paired subtitle sidecars without prefix collisions', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-subtitles-'));
		roots.push(root);
		const directory = path.join(root, 'Movie');
		await mkdir(directory);
		for (const filename of [
			'Movie.en.default.srt',
			'Movie-cd1.es.forced.ass',
			'Movie-cd2.fr.idx',
			'Movie-cd2.fr.sub',
			'Movie Trailer.en.vtt',
		]) {
			await writeFile(path.join(directory, filename), 'subtitle');
		}

		const located = await discoverSidecarSubtitles(
			root,
			path.join(directory, 'Movie'),
			[
				{ stem: path.join(directory, 'Movie-cd1'), partNumber: 1 },
				{ stem: path.join(directory, 'Movie-cd2'), partNumber: 2 },
			],
			(relativePath) => path.posix.join('/media', relativePath),
		);

		expect(located.map(({ track }) => track)).toEqual(expect.arrayContaining([
			expect.objectContaining({
				sourceType: 'sidecar',
				partNumber: null,
				format: 'srt',
				language: 'en',
				isDefault: true,
				relativePaths: ['Movie/Movie.en.default.srt'],
			}),
			expect.objectContaining({
				partNumber: 1,
				format: 'ass',
				language: 'es',
				isForced: true,
			}),
			expect.objectContaining({
				partNumber: 2,
				format: 'vobsub',
				codec: 'dvd_subtitle',
				language: 'fr',
				relativePaths: ['Movie/Movie-cd2.fr.idx', 'Movie/Movie-cd2.fr.sub'],
			}),
		]));
		expect(located).toHaveLength(3);
	});
});

describe('embeddedSubtitleTracks', () => {
	it('retains stream identity, language, title, and playback dispositions', () => {
		const probe: MediaProbeResult = {
			durationMilliseconds: 1_000,
			fileSizeBytes: 1,
			container: 'matroska',
			resolution: { width: 1920, height: 1080 },
			tags: {},
			streams: [{
				index: 4,
				type: 'subtitle',
				codec: 'ass',
				width: null,
				height: null,
				language: 'eng',
				title: 'Signs and songs',
				isDefault: false,
				isForced: true,
				isHearingImpaired: false,
				isCommentary: false,
			}],
		};

		expect(embeddedSubtitleTracks(probe, 2, 'Movie-cd2.mkv')).toEqual([
			expect.objectContaining({
				sourceType: 'embedded',
				partNumber: 2,
				streamIndex: 4,
				codec: 'ass',
				language: 'eng',
				title: 'Signs and songs',
				isForced: true,
			}),
		]);
	});
});
