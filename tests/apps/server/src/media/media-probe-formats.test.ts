import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selectAudio } from '@server/playback/audio-selection.js';
import type { Library } from '@moirai/shared';
import { discoverOnDisk } from '@server/scanner/on-disk.js';
import { mkdir } from 'node:fs/promises';
import { MediaProbe } from '@server/media/media-probe.js';

const ffmpeg = process.env.MOIRAI_TEST_FFMPEG ?? 'ffmpeg';
let root: string;
let probe: MediaProbe;

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'moirai-probe-formats-'));
	probe = new MediaProbe('ffprobe', 1, 10_000);
	await probe.start();
	expect(probe.health().status).toBe('ready');
});

afterAll(async () => {
	await probe?.close();
	if (root) {
		await rm(root, { recursive: true, force: true });
	}
});

/** Encode tiny real media so tests cover ffprobe field filtering and descriptor input. */
function encode(name: string, options: string[], source = 'color=s=64x64:r=25:d=2'): string {
	const file = path.join(root, name);
	execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', source,
		'-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2', '-threads', '1', ...options, file]);
	return file;
}

/** Rename only the generated plain tag, preserving EBML lengths and authored suffixed tags. */
async function removePlainDurationTags(file: string): Promise<void> {
	const bytes = await readFile(file);
	const marker = Buffer.from('DURATION');
	for (let offset = bytes.indexOf(marker); offset >= 0; offset = bytes.indexOf(marker, offset + marker.length)) {
		// FFmpeg stores the suffix as an EBML TagLanguage element (0x447A) after TagName.
		const languageTag = bytes.readUInt16BE(offset + marker.length) === 0x447A;
		if (!languageTag) {
			bytes.write('IGNORED_', offset);
		}
	}
	await writeFile(file, bytes);
}

describe('real media probing', () => {
	it('retains suffixed video/audio durations and audio channel counts through ffprobe filtering', async () => {
		const file = encode('suffixed.mkv', ['-c:v', 'libx264', '-c:a', 'aac',
			'-metadata:s:v:0', 'DURATION-eng=00:00:01.500000000',
			'-metadata:s:a:0', 'DURATION-fra=00:00:01.750000000']);
		await removePlainDurationTags(file);
		const result = await probe.probe(root, file);
		expect(result.durationMilliseconds).toBe(1_500);
		expect(result.streams).toEqual([
			expect.objectContaining({ type: 'video', durationMilliseconds: 1_500 }),
			expect.objectContaining({ type: 'audio', durationMilliseconds: 1_750, channels: 2 }),
		]);
	});

	it.each(['mkv', 'webm'])('uses container timing for an untagged %s video', async extension => {
		const file = encode(`untagged.${extension}`, ['-c:v', 'libvpx-vp9', '-c:a', 'libopus']);
		await removePlainDurationTags(file);
		const result = await probe.probe(root, file);
		expect(result.durationMilliseconds).toBeGreaterThanOrEqual(2_000);
		expect(result.durationMilliseconds).toBeLessThan(2_100);
		expect(result.streams.every(stream => stream.durationMilliseconds === null)).toBe(true);
	});

	it.each([
		['h264.mp4', 'libx264', 'aac'],
		['h264.mov', 'libx264', 'aac'],
		['mpeg4.avi', 'mpeg4', 'mp3'],
		['h264.ts', 'libx264', 'aac'],
		['h264.m2ts', 'libx264', 'ac3'],
		['vp9.webm', 'libvpx-vp9', 'libopus'],
		['h264.mkv', 'libx264', 'aac'],
		['ffv1.mkv', 'ffv1', 'flac'],
	])('keeps video timing for %s', async (name, video, audio) => {
		const file = encode(name, ['-c:v', video, '-c:a', audio]);
		const result = await probe.probe(root, file);
		expect(result.durationMilliseconds).toBeGreaterThanOrEqual(2_000);
		expect(result.durationMilliseconds).toBeLessThan(2_100);
		expect(result.streams.find(stream => stream.type === 'video')?.durationMilliseconds)
			.toBe(result.durationMilliseconds);
		expect(result.streams.find(stream => stream.type === 'audio')?.channels).toBe(2);
	});

	it('preserves missing-duration failures when live WebM has no timing source', async () => {
		const file = encode('live.webm', ['-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-live', '1']);
		await expect(probe.probe(root, file)).rejects.toMatchObject({ code: 'missing-duration' });
	});

	it('keeps the output limit when requesting all stream tags', async () => {
		const input = encode('small.mkv', ['-c:v', 'libx264', '-c:a', 'aac']);
		const metadata = path.join(root, 'large-metadata.txt');
		await writeFile(metadata, `;FFMETADATA1\n[STREAM]\nCOMMENT=${'x'.repeat(300_000)}\n`);
		const file = path.join(root, 'large-tags.mkv');
		execFileSync(ffmpeg, ['-v', 'error', '-i', input, '-f', 'ffmetadata', '-i', metadata,
			'-map', '0', '-map_metadata:s:v:0', '1:s:0', '-c', 'copy', file]);
		await expect(probe.probe(root, file)).rejects.toMatchObject({ code: 'invalid-output' });
	});
});


it.each([
	['mp4', 'handler_name'], ['mkv', 'title-eng'],
])('selects a named audio track from real %s metadata', async (extension, key) => {
	const file = encode(`named.${extension}`, ['-c:v', 'libx264', '-c:a', 'aac', '-metadata:s:a:0', `${key}=Director Commentary`]);
	const result = await probe.probe(root, file);
	expect(result.streams.find(stream => stream.type === 'audio')?.title).toBe('Director Commentary');
	expect(selectAudio({ streams: [...result.streams, { ...result.streams[1], index: 5, title: 'Main', titleAliases: ['Main'], isDefault: true }] }, { title: 'Commentary' })).toBe(1);
});


it.each([
	['hevc.mkv', 'libx265', 'eac3', 'hevc', ['-x265-params', 'pools=none:frame-threads=1:log-level=error']],
	['hevc.mp4', 'libx265', 'aac', 'hevc', ['-x265-params', 'pools=none:frame-threads=1:log-level=error']],
	['av1.mkv', 'libaom-av1', 'dca', 'av1', ['-cpu-used', '8', '-strict', '-2']],
	['av1.webm', 'libaom-av1', 'libopus', 'av1', ['-cpu-used', '8']],
	['mpeg2.mpg', 'mpeg2video', 'mp2', 'mpeg2video', []],
	['mpeg2.mpeg', 'mpeg2video', 'mp2', 'mpeg2video', []],
	['h264.m4v', 'libx264', 'aac', 'h264', ['-f', 'mp4']],
] as const)('probes and software-decodes representative %s media', async (name, video, audio, codec, extra) => {
	const file = encode(name, ['-c:v', video, '-c:a', audio, ...extra], 'testsrc2=s=160x120:r=25:d=2');
	const result = await probe.probe(root, file);
	const selected = result.streams.find(stream => stream.type === 'video')!;
	expect(selected.codec).toBe(codec);
	expect(result.durationMilliseconds).toBeGreaterThanOrEqual(1_900);
	expect(result.durationMilliseconds).toBeLessThan(2_150);
	expect(result.streams.find(stream => stream.type === 'audio')?.codec).toBe(audio === 'dca' ? 'dts' : audio === 'libopus' ? 'opus' : audio);
	execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-map', `0:${selected.index}`, '-map', '0:a:0', '-t', '0.5', '-f', 'null', '-']);
}, 30_000);


it('discovers MPEG program streams and M4V through the real scanner and probe', async () => {
	const directory = path.join(root, 'discovery');
	await mkdir(directory);
	for (const extension of ['mpg', 'mpeg', 'm4v']) {
		encode(`discovery/Film-${extension}.${extension}`, extension === 'm4v'
			? ['-c:v', 'libx264', '-c:a', 'aac', '-f', 'mp4'] : ['-c:v', 'mpeg2video', '-c:a', 'mp2'], 'testsrc2=s=160x120:r=25:d=2');
	}
	const library = { id: crypto.randomUUID(), name: 'Formats', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: directory, playbackRoot: directory } } as Library;
	const discovered = await discoverOnDisk(library, { probeMedia: (scanRoot, file) => probe.probe(scanRoot, file) });
	expect(discovered.items.map(item => item.relativePath).sort()).toEqual(['Film-m4v.m4v', 'Film-mpeg.mpeg', 'Film-mpg.mpg']);
	for (const item of discovered.items) {
		expect(item.probeStatus).toBe('complete');
		expect(item.durationMilliseconds).toBeGreaterThanOrEqual(1_900);
	}
});

it('retains coexisting localized names and descriptive-audio flags through ffprobe', async () => {
	const file = encode('aliases.mkv', ['-c:v', 'libx264', '-c:a', 'aac', '-metadata:s:a:0', 'title=Main',
		'-metadata:s:a:0', 'title-eng=English Original', '-disposition:a:0', 'visual_impaired']);
	const result = await probe.probe(root, file);
	const audio = result.streams.find(stream => stream.type === 'audio')!;
	expect(audio).toMatchObject({ title: 'Main', titleAliases: ['Main', 'English Original'], isAudioDescription: true });
	expect(selectAudio(result, { title: 'Original' })).toBe(audio.index);
});
