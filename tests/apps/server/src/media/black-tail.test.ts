import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blackTailResult, inspectBlackTail, MAX_BLACK_TAIL_SECONDS, BLACK_TAIL_PIXEL_RATIO } from '@server/media/black-tail.js';
import { mediaProbeFingerprint } from '@server/media/media-probe.js';

const ffmpeg = process.env.MOIRAI_TEST_FFMPEG ?? 'ffmpeg';
let root: string;
beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'moirai-black-tail-')); 
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true }); 
});

describe('black-tail inspection', () => {
	it.each([-1, 0, 1])('checks the per-frame percentage at cutoff offset %s', async offset => {
		const file = path.join(root, `boundary-${offset}.mkv`);
		const whiteWidth = Math.round((1 - BLACK_TAIL_PIXEL_RATIO) * 100) + offset;
		execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=100x100:r=24:d=3',
			'-vf', `drawbox=x=0:y=0:w=${whiteWidth}:h=100:color=white:t=fill`, '-c:v', 'ffv1', file]);
		const fingerprint = mediaProbeFingerprint(await stat(file, { bigint: true }));
		await expect(inspectBlackTail(root, file, { streamIndex: 0, startSeconds: 1, durationSeconds: 2, fingerprint }, undefined, ffmpeg))
			.resolves.toBe(offset <= 0 ? 'mostly-black' : 'not-black');
	});

	it('suppresses white credits on black throughout the tail', async () => {
		const file = path.join(root, 'credits.mkv');
		execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x360:r=24:d=3',
			'-vf', "drawtext=text='VERSION FRANCAISE':fontcolor=white:fontsize=24:x=(w-tw)/2:y=100",
			'-c:v', 'ffv1', file]);
		const fingerprint = mediaProbeFingerprint(await stat(file, { bigint: true }));
		await expect(inspectBlackTail(root, file, { streamIndex: 0, startSeconds: 1, durationSeconds: 2, fingerprint }, undefined, ffmpeg))
			.resolves.toBe('mostly-black');
	});

	it.each(['black', 'white'])('decodes the entire %s tail through a validated descriptor', async color => {
		const file = path.join(root, `${color}.mp4`);
		execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=64x64:r=24:d=3`, '-c:v', 'libx264', file]);
		const fingerprint = mediaProbeFingerprint(await stat(file, { bigint: true }));
		await expect(inspectBlackTail(root, file, { streamIndex: 0, startSeconds: 1, durationSeconds: 2, fingerprint }, undefined, ffmpeg))
			.resolves.toBe(color === 'black' ? 'mostly-black' : 'not-black');
		await expect(inspectBlackTail(root, file, { streamIndex: 0, startSeconds: 1, durationSeconds: 2, fingerprint: 'stale' }, undefined, ffmpeg))
			.resolves.toBe('uncertain');
	});

	it('keeps a brief visible frame within an otherwise black tail active', async () => {
		const file = path.join(root, 'brief-content.mp4');
		execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:r=24:d=3',
			'-vf', "drawbox=x=0:y=0:w=64:h=64:color=white:t=fill:enable='between(t,1.45,1.55)'", '-c:v', 'libx264', file]);
		const fingerprint = mediaProbeFingerprint(await stat(file, { bigint: true }));
		await expect(inspectBlackTail(root, file, { streamIndex: 0, startSeconds: 1, durationSeconds: 2, fingerprint }, undefined, ffmpeg))
			.resolves.toBe('not-black');
		await expect(inspectBlackTail(root, file, { streamIndex: 0, startSeconds: 1, durationSeconds: 2, fingerprint }, undefined, '/missing/ffmpeg'))
			.resolves.toBe('uncertain');
	});

	it('never suppresses partial black intervals or incomplete decoding', () => {
		expect(blackTailResult('out_time_us=40000000', 'black_start:0 black_end:20', 40)).toBe('not-black');
		expect(blackTailResult('out_time_us=20000000', 'black_start:0 black_end:40', 40)).toBe('uncertain');
	});

	it('leaves excessive tails and missing files uncertain and respects cancellation', async () => {
		const target = { streamIndex: 0, startSeconds: 10, durationSeconds: MAX_BLACK_TAIL_SECONDS + 1, fingerprint: 'unused' };
		await expect(inspectBlackTail(root, 'missing.mp4', target)).resolves.toBe('uncertain');
		await expect(inspectBlackTail(root, 'missing.mp4', { ...target, durationSeconds: 40 })).resolves.toBe('uncertain');
		await expect(inspectBlackTail(root, 'missing.mp4', target, AbortSignal.abort())).rejects.toThrow();
	});
});
