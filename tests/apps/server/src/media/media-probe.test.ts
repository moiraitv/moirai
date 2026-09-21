import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_MEDIA_DURATION_MILLISECONDS } from '@moirai/shared';
import {
	MediaProbe,
	MediaProbeError,
	parseMediaProbeOutput,
} from '@server/media/media-probe.js';

const roots: string[] = [];

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
			fileSizeBytes: 42,
			container: 'matroska,webm',
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'hevc',
					durationMilliseconds: 65_000,
					width: 3840,
					height: 2160,
					channels: null,
					language: null,
					title: null,
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
					width: null,
					height: null,
					channels: null,
					language: null,
					title: null,
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

	it('uses the longest video duration but never accepts an audio-only file', () => {
		const video = JSON.stringify({
			streams: [
				{ codec_type: 'video', codec_name: 'h264', duration: '10.25' },
				{ codec_type: 'video', codec_name: 'h264', duration: '10.5' },
				{ codec_type: 'audio', codec_name: 'aac', duration: '11.75' },
				{ codec_type: 'subtitle', duration: '20' },
			],
		});
		expect(parseMediaProbeOutput(video, 1).durationMilliseconds).toBe(10_500);
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
		'rejects unusable video duration %s despite measured container and audio durations',
		(duration) => {
			expect(() => parseMediaProbeOutput(JSON.stringify({
				format: { duration: '100' },
				streams: [
					{ codec_type: 'video', duration },
					{ codec_type: 'audio', duration: '100' },
				],
			}), 1)).toThrow(expect.objectContaining({ code: 'missing-duration' }));
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
