import { spawn } from 'node:child_process';
import { openSourceFile } from './source-file.js';
import { mediaProbeFingerprint } from './media-probe.js';

/** Bound optional tail decoding to two minutes of source and thirty seconds of wall time. */
export const MAX_BLACK_TAIL_SECONDS = 120;
/** Minimum dark-pixel fraction required in every frame of an automatically suppressed tail. */
export const BLACK_TAIL_PIXEL_RATIO = 0.9;
/** One verified video stream and the complete interval after the earliest audio ending. */
export interface BlackTailTarget {
	streamIndex: number;
	startSeconds: number;
	durationSeconds: number;
	fingerprint: string;
}
/** Cached conservative outcome; uncertain findings always remain visible. */
export type BlackTailResult = 'black' | 'mostly-black' | 'not-black' | 'uncertain';

/** Require a complete mostly black interval and decoded output reaching the expected tail endpoint. */
export function blackTailResult(stdout: string, stderr: string, duration: number): BlackTailResult {
	const progress = [...stdout.matchAll(/out_time_us=(\d+)/gu)].at(-1);
	if (!progress || Number(progress[1]) / 1_000_000 < duration - 0.1) {
		return 'uncertain';
	}
	const intervals = [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/gu)];
	return intervals.some(match => Number(match[1]) <= 0.1 && Number(match[2]) >= duration - 0.1)
		? 'mostly-black' : 'not-black';
}

/** Decode every tail frame through a validated descriptor; failures never suppress warnings. */
export async function inspectBlackTail(root: string, file: string, target: BlackTailTarget, signal?: AbortSignal, executable = 'ffmpeg'): Promise<BlackTailResult> {
	signal?.throwIfAborted();
	if (target.durationSeconds <= 0 || target.durationSeconds > MAX_BLACK_TAIL_SECONDS) {
		return 'uncertain';
	}
	try {
		const source = await openSourceFile(root, file);
		try {
			if (mediaProbeFingerprint(await source.handle.stat({ bigint: true })) !== target.fingerprint) {
				return 'uncertain';
			}
			const result = await new Promise<BlackTailResult>((resolve) => {
				const child = spawn(executable, [
					'-hide_banner', '-nostdin', '-nostats', '-xerror', '-threads', '1',
					'-ss', String(target.startSeconds), '-fd', '4', '-i', 'fd:',
					'-map', `0:${target.streamIndex}`, '-an', '-sn', '-dn',
					'-t', String(target.durationSeconds), '-filter_threads', '1',
					'-vf', `blackdetect=d=0:pix_th=0.03:pic_th=${BLACK_TAIL_PIXEL_RATIO}`,
					'-progress', 'pipe:1', '-f', 'null', '-',
				], { stdio: ['ignore', 'pipe', 'pipe', 'ignore', source.handle.fd] });
				let stdout = '';
				let stderr = '';
				let stopped = false;
				const stop = (): void => {
					stopped = true;
					child.kill('SIGKILL');
				};
				const timeout = setTimeout(stop, 30_000);
				timeout.unref();
				signal?.addEventListener('abort', stop, { once: true });
				if (signal?.aborted) {
					stop();
				}
				child.stdout!.on('data', (chunk: Buffer) => {
					stdout += chunk.toString();
					if (stdout.length > 1_048_576) {
						stop();
					}
				});
				child.stderr!.on('data', (chunk: Buffer) => {
					stderr += chunk.toString();
					if (stderr.length > 1_048_576) {
						stop();
					}
				});
				child.once('error', () => {
					stopped = true; 
				});
				child.once('close', code => {
					clearTimeout(timeout);
					signal?.removeEventListener('abort', stop);
					resolve(code === 0 && !stopped
						? blackTailResult(stdout, stderr, target.durationSeconds) : 'uncertain');
				});
			});
			signal?.throwIfAborted();
			return mediaProbeFingerprint(await source.handle.stat({ bigint: true })) === target.fingerprint ? result : 'uncertain';
		}
		finally {
			await source.handle.close();
		}
	}
	catch {
		signal?.throwIfAborted();
		return 'uncertain';
	}
}
