import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { parseMediaProbeOutput } from '@server/media/media-probe.js';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { prepareAudio } from '@server/playback/audio-selection.js';
import { buildEtvPlayoutFiles } from '@server/playback/playout-output.js';
import { channelCreateSchema, type ScheduleGuide, type TimelineSegment } from '@moirai/shared';

it('probes multiple audio tracks and publishes the selected physical-part indices', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-audio-'));
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const ffmpeg = process.env.MOIRAI_TEST_FFMPEG ?? 'ffmpeg';
		const probe = path.isAbsolute(ffmpeg) ? path.join(path.dirname(ffmpeg), 'ffprobe') : 'ffprobe';
		const files = [path.join(root, 'one.mkv'), path.join(root, 'two.mkv')];
		const metadata = files.map((file, index) => {
			execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=32x32:r=1:d=1',
				'-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=stereo', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=5.1',
				'-map', '0:v', '-map', '1:a', '-map', '2:a', '-t', '1', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le',
				'-metadata:s:a:0', `language=${index ? 'fra' : 'eng'}`, '-metadata:s:a:1', `language=${index ? 'eng' : 'fra'}`,
				'-metadata:s:a:1', 'title=Original Surround', file]);
			return parseMediaProbeOutput(execFileSync(probe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }), 1);
		});
		expect(metadata[0]!.streams.filter((stream) => stream.type === 'audio').map((stream) => stream.channels)).toEqual([2, 6]);
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Audio', audioPreferences: { language: 'fr' } }));
		const libraryId = randomUUID();
		const mediaId = randomUUID();
		database.sqlite.prepare("INSERT INTO libraries (id, name, type_key, source_type, source_config) VALUES (?, 'Library', 'movies', 'on-disk', '{}')").run(libraryId);
		const parts = files.map((playbackPath, index) => ({ playbackPath, partNumber: index + 1, durationMilliseconds: 1000 }));
		database.sqlite.prepare(`INSERT INTO media_items (id, library_id, stable_key, kind, title, sort_title, relative_path, playback_path, metadata_status, metadata, fingerprint, duration_milliseconds, parts, technical_metadata)
			VALUES (?, ?, 'video', 'movie', 'Video', 'Video', 'one.mkv', ?, 'complete', '{}', 'fixture', 2000, ?, ?)`)
			.run(mediaId, libraryId, files[0], JSON.stringify(parts), JSON.stringify({ parts: metadata }));
		const segment = { id: randomUUID(), channelId: channel.id, mediaItemId: mediaId, programId: null, role: 'primary', title: 'Video',
			playbackPath: files[0], playbackParts: files.map((playbackPath) => ({ playbackPath, durationSeconds: 1 })),
			start: '2026-01-01T00:00:00Z', finish: '2026-01-01T00:00:02Z', sourceStartSeconds: 0, sourceFinishSeconds: 2,
		} as TimelineSegment;
		const guide = { startDate: '2026-01-01', days: 1, timeZone: 'UTC', channels: [{ channelId: channel.id, preview: { segments: [segment] } }] } as ScheduleGuide;
		const selected = await prepareAudio(repository, channel, guide, []);
		expect(selected.get(segment.id)).toEqual([2, 1]);
		const document = JSON.parse([...buildEtvPlayoutFiles([channel], guide, new Map(), undefined, selected).values()][0]!);
		const videos = document.items.filter((item: { source?: { path?: string } }) => item.source?.path);
		expect(videos.map((item: { tracks: { audio: { stream_index: number } } }) => item.tracks.audio.stream_index)).toEqual([2, 1]);
		expect((await repository.getChannel(channel.id))!.audioPreferences).toEqual({ language: 'fr' });
	}
	finally {
		database.close();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);

it.each(['single', 'legacy', 'missing-multipart'] as const)('uses top-level audio metadata only for single-file media (%s)', async (shape) => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Audio' }));
		const libraryId = randomUUID();
		const mediaId = randomUUID();
		const playbackPath = '/fixture/movie.mkv';
		const metadata = { streams: [
			{ type: 'audio', index: 1, language: 'ita', title: 'ITA 5.1 AC3', isDefault: true, channels: 6 },
			{ type: 'audio', index: 2, language: 'eng', title: 'ENG 5.1 AC3', isDefault: false, channels: 6 },
		] };
		const part = { number: 1, relativePath: 'movie.mkv', playbackPath, durationSeconds: 1, subtitleTracks: [] };
		const parts = shape === 'legacy' ? [] : shape === 'single' ? [part] : [part, { ...part, number: 2, playbackPath: '/fixture/two.mkv' }];
		database.sqlite.prepare("INSERT INTO libraries (id, name, type_key, source_type, source_config) VALUES (?, 'Library', 'movies', 'on-disk', '{}')").run(libraryId);
		database.sqlite.prepare(`INSERT INTO media_items (id, library_id, stable_key, kind, title, sort_title, relative_path, playback_path, metadata_status, metadata, fingerprint, duration_milliseconds, parts, technical_metadata)
			VALUES (?, ?, 'video', 'movie', 'Video', 'Video', 'movie.mkv', ?, 'complete', '{}', 'fixture', 1000, ?, ?)`)
			.run(mediaId, libraryId, playbackPath, JSON.stringify(parts), JSON.stringify(metadata));
		const segment = { id: randomUUID(), channelId: channel.id, mediaItemId: mediaId, programId: null, role: 'primary', title: 'Video',
			playbackPath, playbackParts: (parts.length ? parts : [part]).map((value) => ({ playbackPath: value.playbackPath, durationSeconds: 1 })),
			start: '2026-01-01T00:00:00Z', finish: '2026-01-01T00:00:02Z', sourceStartSeconds: 0, sourceFinishSeconds: 2,
		} as TimelineSegment;
		const guide = { startDate: '2026-01-01', days: 1, timeZone: 'UTC', channels: [{ channelId: channel.id, preview: { segments: [segment] } }] } as ScheduleGuide;

		for (const preference of [{ language: 'eng', title: 'English' }, { language: 'en', title: 'eng' }, { title: 'ENG' }]) {
			const selectedChannel = { ...channel, audioPreferences: preference };
			const selected = await prepareAudio(repository, selectedChannel, guide, []);
			const expected = shape === 'missing-multipart' ? [null, null] : [2];
			expect(selected.get(segment.id)).toEqual(expected);

			const document = JSON.parse([...buildEtvPlayoutFiles([selectedChannel], guide, new Map(), undefined, selected).values()][0]!);
			const videos = document.items.filter((item: { source?: { path?: string } }) => item.source?.path);
			expect(videos.map((item: { tracks?: { audio?: { stream_index?: number } } }) => item.tracks?.audio?.stream_index ?? null)).toEqual(expected);
		}
	}
	finally {
		database.close();
	}
});
