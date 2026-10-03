import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_MEDIA_DURATION_MILLISECONDS, MAX_MID_ROLL_POINTS } from '@moirai/shared';
import {
	MediaProbe,
	MediaProbeError,
	mediaProbeFingerprint,
	parseMediaProbeOutput,
} from '@server/media/media-probe.js';

const roots: string[] = [];

it('keeps probe fingerprints stable across remounts but invalidates changed file facts', () => {
	const before = { dev: 1, ino: 2, size: 500, mtimeMs: 1_000 };
	const remounted = { ...before, dev: 9, ino: 22 };
	expect(mediaProbeFingerprint(remounted)).toBe(mediaProbeFingerprint(before));
	expect(mediaProbeFingerprint({ ...remounted, size: 501 })).not.toBe(mediaProbeFingerprint(before));
	expect(mediaProbeFingerprint({ ...remounted, mtimeMs: 2_000 })).not.toBe(mediaProbeFingerprint(before));
	expect(mediaProbeFingerprint({ size: 500n, mtimeMs: 1_000n })).toBe(mediaProbeFingerprint(before));
});

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('media probe output', () => {
	it('uses video duration and retains bounded playback facts', () => {
		expect(parseMediaProbeOutput(JSON.stringify({
			format: { duration: '65.125', format_name: 'matroska,webm' },
			streams: [
				{ codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, duration: '65' },
				{ codec_type: 'audio', codec_name: 'aac', duration: '64.5' },
			],
		}), 42)).toEqual({
			durationMilliseconds: 65_000,
			chapters: [],
			chapterLimitExceeded: false,
			fileSizeBytes: 42,
			container: 'matroska,webm',
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'hevc',
					durationMilliseconds: 65_000,
					startMilliseconds: null,
					isAttachedPicture: false,
					width: 3840,
					height: 2160,
					channels: null,
					language: null,
					title: null,
					titleAliases: [],
					isAudioDescription: false,
					isDefault: false,
					isForced: false,
					isHearingImpaired: false,
					isCommentary: false,
				},
				{
					index: 1,
					type: 'audio',
					codec: 'aac',
					durationMilliseconds: 64_500,
					startMilliseconds: null,
					isAttachedPicture: false,
					width: null,
					height: null,
					channels: null,
					language: null,
					title: null,
					titleAliases: [],
					isAudioDescription: false,
					isDefault: false,
					isForced: false,
					isHearingImpaired: false,
					isCommentary: false,
				},
			],
			resolution: { width: 3840, height: 2160 },
			tags: {},
		});
	});

	it('uses the first video duration but never accepts an audio-only file', () => {
		const video = JSON.stringify({
			streams: [
				{ codec_type: 'video', codec_name: 'h264', duration: '10.25' },
				{ codec_type: 'video', codec_name: 'h264', duration: '10.5' },
				{ codec_type: 'audio', codec_name: 'aac', duration: '11.75' },
				{ codec_type: 'subtitle', duration: '20' },
			],
		});
		expect(parseMediaProbeOutput(video, 1).durationMilliseconds).toBe(10_250);
		expect(() => parseMediaProbeOutput(JSON.stringify({
			format: { duration: '10' },
			streams: [{ codec_type: 'audio', codec_name: 'aac' }],
		}), 1)).toThrow(MediaProbeError);
	});

	it('uses Matroska duration tags when native stream durations are unavailable', () => {
		const result = parseMediaProbeOutput(JSON.stringify({
			format: { duration: '100', format_name: 'matroska,webm' },
			streams: [{
				codec_type: 'video',
				codec_name: 'vp9',
				width: 1920,
				height: 1080,
				tags: { DURATION: '00:01:05.125000000' },
			}],
		}), 42);

		expect(result.durationMilliseconds).toBe(65_125);
		expect(result.streams[0]?.durationMilliseconds).toBe(65_125);
	});

	it('rejects measured durations beyond the scheduling limit', () => {
		const durationSeconds = MAX_MEDIA_DURATION_MILLISECONDS / 1_000 + 1;
		expect(() => parseMediaProbeOutput(JSON.stringify({
			format: { duration: String(durationSeconds) },
			streams: [{ codec_type: 'video', codec_name: 'h264', duration: String(durationSeconds) }],
		}), 1)).toThrow(MediaProbeError);
	});

	it('ignores inflated container and audio durations like the Stargate file', () => {
		const result = parseMediaProbeOutput(JSON.stringify({
			format: { duration: '26025.108' },
			streams: [
				{ codec_type: 'video', duration: '7781.523733' },
				{ codec_type: 'audio', duration: '26025.108' },
				{ codec_type: 'audio', duration: '26025.082' },
			],
		}), 1);

		expect(result.durationMilliseconds).toBe(7_781_524);
	});

	it.each([undefined, '0', '-1', 'NaN', 'Infinity'])(
		'uses container timing for a single unmeasured video (%s)',
		(duration) => {
			const result = parseMediaProbeOutput(JSON.stringify({
				format: { duration: '100' },
				streams: [
					{ codec_type: 'video', duration },
					{ codec_type: 'audio', duration: '100' },
				],
			}), 1);
			expect(result.durationMilliseconds).toBe(100_000);
			expect(result.streams[0]?.durationMilliseconds).toBeNull();
		},
	);

	it('captures bounded container tags and embedded subtitle dispositions', () => {
		const result = parseMediaProbeOutput(JSON.stringify({
			format: {
				duration: '10',
				tags: { TITLE: 'Tagged title', ARTIST: 'Artist', unrelated: 'ignored' },
			},
			streams: [
				{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, duration: '10' },
				{
					index: 3,
					codec_type: 'subtitle',
					codec_name: 'subrip',
					tags: { language: 'ENG', title: 'English forced' },
					disposition: { forced: 1, default: 0, hearing_impaired: 1, comment: 0 },
				},
			],
		}), 1);

		expect(result.tags).toEqual({ title: 'Tagged title', artist: 'Artist' });
		expect(result.streams[1]).toMatchObject({
			index: 3,
			type: 'subtitle',
			codec: 'subrip',
			language: 'eng',
			title: 'English forced',
			isDefault: false,
			isForced: true,
			isHearingImpaired: true,
			isCommentary: false,
		});
	});
});

describe('MediaProbe', () => {
	it('runs the configured executable against a validated media descriptor', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-probe-'));
		roots.push(root);
		const file = path.join(root, 'fixture.mp4');
		await writeFile(file, 'fixture');
		const probe = new MediaProbe(path.resolve('tests/fixtures/fake-ffprobe.mjs'), 1, 2_000);
		await probe.start();
		await expect(probe.probe(root, file)).resolves.toMatchObject({
			durationMilliseconds: 5_880_125,
			fileSizeBytes: 7,
			resolution: { width: 1920, height: 1080 },
		});
		await probe.close();
	});

	it('reports an unavailable executable without exposing its path as probe data', async () => {
		const probe = new MediaProbe('/missing/moirai-ffprobe', 1, 1_000);
		await probe.start();
		expect(probe.health()).toMatchObject({ status: 'degraded' });
		await probe.close();
	});

	it('rejects ffprobe builds without seekable descriptor input', async () => {
		const probe = new MediaProbe(
			path.resolve('tests/fixtures/fake-ffprobe-without-fd.mjs'),
			1,
			5_000,
		);
		await probe.start();
		expect(probe.health()).toMatchObject({
			status: 'degraded',
			detail: expect.stringContaining('seekable descriptor input'),
		});
		await probe.close();
	});
});


describe('duration tag variants and container fallback', () => {
	it.each(['DURATION-eng', 'duration-FRA', 'DuRaTiOn-und'])('accepts %s for video and audio', key => {
		const result = parseMediaProbeOutput(JSON.stringify({
			format: { duration: '100' },
			streams: [
				{ codec_type: 'video', tags: { [key]: '00:01:05.125000000' } },
				{ codec_type: 'audio', tags: { [key]: '00:01:04.500000000' } },
			],
		}), 1);
		expect(result.durationMilliseconds).toBe(65_125);
		expect(result.streams.map(stream => stream.durationMilliseconds)).toEqual([65_125, 64_500]);
	});

	it.each([
		[{ 'DURATION-eng': '00:00:20', DURATION: '00:00:10' }, undefined, 10_000],
		[{ DURATION: '00:00:10', 'DURATION-eng': '00:00:20' }, '5', 5_000],
		[{ DURATION: 'invalid', 'DURATION-eng': '00:00:20' }, 'N/A', 20_000],
		[{ DURATION: '00:00:00', 'DURATION-eng': '00:00:20' }, undefined, 20_000],
		[{ DURATION: '99999:00:00', 'DURATION-eng': '00:00:20' }, undefined, 20_000],
		[{ 'DURATION-eng': '00:60:00', 'DURATION-fra': '00:00:30' }, undefined, 30_000],
		[{ 'DURATION-fra': '00:00:30', 'DURATION-eng': '00:00:20' }, undefined, 20_000],
		[{ 'DURATION-eng': '00:00:20', 'DURATION-fra': '00:00:30' }, undefined, 20_000],
	])('applies native, plain, then valid suffixed precedence (%j)', (tags, duration, expected) => {
		const result = parseMediaProbeOutput(JSON.stringify({
			streams: [{ codec_type: 'video', duration, tags }],
		}), 1);
		expect(result.durationMilliseconds).toBe(expected);
	});

	it.each(['DURATION-extra', 'DURATION-eng-extra', 'OTHER_DURATION', 'DURATION-en'])('ignores unrelated tag %s without borrowing audio duration', key => {
		expect(() => parseMediaProbeOutput(JSON.stringify({ streams: [
			{ codec_type: 'video', tags: { [key]: '00:01:00' } },
			{ codec_type: 'audio', duration: 60 },
		] }), 1)).toThrow(expect.objectContaining({ code: 'missing-duration' }));
	});

	it.each([undefined, 'N/A', '0', '-1', 'Infinity', 'NaN', true, [], {},
		MAX_MEDIA_DURATION_MILLISECONDS / 1_000 + 1])('rejects invalid container fallback %j', duration => {
		expect(() => parseMediaProbeOutput(JSON.stringify({
			format: { duration }, streams: [{ codec_type: 'video' }],
		}), 1)).toThrow(expect.objectContaining({ code: 'missing-duration' }));
	});

	it('allows the scheduling limit and ignores attached artwork when counting videos', () => {
		const result = parseMediaProbeOutput(JSON.stringify({
			format: { duration: MAX_MEDIA_DURATION_MILLISECONDS / 1_000 },
			streams: [
				{ codec_type: 'video', duration: '1', disposition: { attached_pic: 1 } },
				{ codec_type: 'video' },
			],
		}), 1);
		expect(result.durationMilliseconds).toBe(MAX_MEDIA_DURATION_MILLISECONDS);
		expect(result.streams[1]?.durationMilliseconds).toBeNull();
	});

	it('rejects artwork-only media even with valid container timing', () => {
		expect(() => parseMediaProbeOutput(JSON.stringify({
			format: { duration: '100' },
			streams: [{ codec_type: 'video', duration: '100', disposition: { attached_pic: 1 } }],
		}), 1)).toThrow(expect.objectContaining({ code: 'missing-video' }));
	});

	it('does not use container timing for multiple unmeasured video tracks', () => {
		expect(() => parseMediaProbeOutput(JSON.stringify({
			format: { duration: '100' },
			streams: [{ codec_type: 'video' }, { codec_type: 'video' }],
		}), 1)).toThrow(expect.objectContaining({ code: 'missing-duration' }));
	});

	it('does not infer a single video when stream records have been truncated', () => {
		expect(() => parseMediaProbeOutput(JSON.stringify({
			format: { duration: '100' },
			streams: [{ codec_type: 'video' },
				...Array.from({ length: 100 }, () => ({ codec_type: 'audio' })), { codec_type: 'video' }],
		}), 1)).toThrow(expect.objectContaining({ code: 'missing-duration' }));
	});
});


it('uses the lowest-index real video for duration and resolution regardless of ordering or default flags', () => {
	const result = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ index: 8, codec_type: 'video', duration: 200, width: 1920, height: 1080, disposition: { default: 1 } },
		{ index: 0, codec_type: 'video', duration: 300, width: 400, height: 400, disposition: { attached_pic: 1 } },
		{ index: 3, codec_type: 'video', duration: 60, width: 640, height: 480 },
	] }), 1);
	expect(result.durationMilliseconds).toBe(60_000);
	expect(result.resolution).toEqual({ width: 640, height: 480 });
});

it('does not borrow timing or geometry from a later video', () => {
	expect(() => parseMediaProbeOutput(JSON.stringify({ format: { duration: 200 }, streams: [
		{ index: 3, codec_type: 'video' }, { index: 8, codec_type: 'video', duration: 200 },
	] }), 1)).toThrow(expect.objectContaining({ code: 'missing-duration' }));
	const result = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ index: 3, codec_type: 'video', duration: 60 },
		{ index: 8, codec_type: 'video', duration: 200, width: 640, height: 480 },
	] }), 1);
	expect(result.resolution).toBeNull();
});

it.each([
	[{ title: 'Plain', 'TITLE-eng': 'Localized', handler_name: 'Handler' }, 'Plain'],
	[{ title: ' ', 'TITLE-eng': 'Localized', handler_name: 'Handler' }, 'Localized'],
	[{ 'TITLE-fra': 'French', 'TITLE-eng': 'English' }, 'English'],
	[{ 'TITLE-eng': '', handler_name: 'Handler' }, 'Handler'],
])('normalizes track titles with explicit precedence (%j)', (tags, expected) => {
	const result = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ codec_type: 'video', duration: 60 }, { codec_type: 'audio', tags },
	] }), 1);
	expect(result.streams[1]?.title).toBe(expected);
});


it('retains bounded alternate titles and audio-description dispositions', () => {
	const result = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ index: 0, codec_type: 'video', duration: '60' },
		{ index: 1, codec_type: 'audio', tags: { title: ' Main ', 'TITLE-eng': 'main', 'TITLE-fra': 'Original', handler_name: 'English Original' }, disposition: { visual_impaired: 1 } },
	] }), 100);
	expect(result.streams[1]).toMatchObject({ title: 'Main', titleAliases: ['Main', 'Original', 'English Original'], isAudioDescription: true });
});

it('normalizes chapter facts without discarding playable content for malformed markers', () => {
	const result = parseMediaProbeOutput(JSON.stringify({
		format: { duration: '120' }, streams: [{ codec_type: 'video', duration: '120' }],
		chapters: [
			{ start_time: '0', end_time: '30.125', tags: { TITLE: ' Act 1 ' } },
			{ start_time: '-1', end_time: '20' },
			{ start_time: '30.125', end_time: '999', tags: { title: 'Final' } },
			{ start_time: '40', end_time: '10' },
			null,
		],
	}), 42);
	expect(result.durationMilliseconds).toBe(120_000);
	expect(result.chapters).toEqual([
		{ startSeconds: 0, finishSeconds: 30.125, title: 'Act 1' },
		{ startSeconds: 30.125, finishSeconds: 120, title: 'Final' },
	]);
	expect(parseMediaProbeOutput(JSON.stringify({ format: { duration: '10' },
		streams: [{ codec_type: 'video', duration: '10' }], chapters: 'invalid' }), 1).chapters).toEqual([]);
});

it('bounds a chapter list at the scheduling cap and flags one extra marker', () => {
	const duration = MAX_MID_ROLL_POINTS + 2;
	const chapters = (count: number) => Array.from({ length: count }, (_, index) => ({
		start_time: String(index), end_time: String(index + 1), tags: { title: `Chapter ${index}` },
	}));
	const probe = (count: number) => parseMediaProbeOutput(JSON.stringify({
		format: { duration: String(duration) },
		streams: [{ codec_type: 'video', duration: String(duration) }],
		chapters: chapters(count),
	}), 1);
	expect(probe(MAX_MID_ROLL_POINTS)).toMatchObject({ chapterLimitExceeded: false, chapters: { length: MAX_MID_ROLL_POINTS } });
	expect(probe(MAX_MID_ROLL_POINTS + 1)).toMatchObject({ chapterLimitExceeded: true, chapters: { length: MAX_MID_ROLL_POINTS } });
});


it.each(['chapters', 'metadata'])('retries an oversized probe once without chapters (%s)', async scenario => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-probe-overflow-'));
	roots.push(root);
	const file = path.join(root, 'fixture.mkv');
	const log = path.join(root, 'calls');
	await writeFile(file, JSON.stringify({ scenario, log }));
	const probe = new MediaProbe(path.resolve('tests/fixtures/fake-ffprobe-overflow.mjs'), 1, 2_000);
	try {
		await probe.start();
		if (scenario === 'chapters') {
			await expect(probe.probe(root, file)).resolves.toMatchObject({ durationMilliseconds: 120_000,
				chapters: [], chapterLimitExceeded: true, streams: [{ type: 'video', codec: 'h264' }] });
		}
		else {
			await expect(probe.probe(root, file)).rejects.toMatchObject({ code: 'invalid-output' });
		}
		expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['chapters', 'metadata']);
	}
	finally {
		await probe.close();
	}
});

it('does not retry chapter overflow after caller cancellation', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-probe-cancel-overflow-'));
	roots.push(root);
	const file = path.join(root, 'fixture.mkv');
	const log = path.join(root, 'calls');
	await writeFile(file, JSON.stringify({ scenario: 'abort', log }));
	const probe = new MediaProbe(path.resolve('tests/fixtures/fake-ffprobe-overflow.mjs'), 1, 2_000);
	const controller = new AbortController();
	try {
		await probe.start();
		const pending = probe.probe(root, file, controller.signal);
		const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
		await expect.poll(async () => readFile(log, 'utf8').catch(() => '')).toBe('chapters\n');
		controller.abort();
		await rejected;
		expect(await readFile(log, 'utf8')).toBe('chapters\n');
	}
	finally {
		await probe.close();
	}
});
