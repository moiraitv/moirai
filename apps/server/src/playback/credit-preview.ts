import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Channel, CreditPreviewResult, MediaItem } from '@moirai/shared';
import { creditContext } from './credit-context.js';
import { renderCreditTemplate } from './credit-renderer.js';

/** FFmpeg preview invocation has no shell and a fixed execution deadline. */
const execute = promisify(execFile);

/** Escape a local path at both FFmpeg filter and option parsing boundaries. */
function filterPath(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "'\\''");
}

/** Render credits over a selected catalog frame at fixed source-relative time. */
export async function previewCredits(source: string, item: MediaItem, channel: Pick<Channel, 'video' | 'ffmpegPath' | 'subtitleFontsFolder'>, seconds: number): Promise<CreditPreviewResult> {
	if (item.kind !== 'music-video' || item.availability !== 'available') {
		throw new Error('Choose an available music video');
	}
	if (item.durationSeconds == null || !Number.isFinite(item.durationSeconds) || item.durationSeconds <= 0) {
		throw new Error('Video duration is unavailable. Inspect the video metadata and scan issues, or refresh after scanning.');
	}
	if (seconds >= item.durationSeconds) {
		throw new Error('Preview time must be within the video');
	}
	const ass = await renderCreditTemplate(source, creditContext(item, channel));
	const directory = await mkdtemp(path.join(tmpdir(), 'moirai-credit-preview-'));
	try {
		const file = path.join(directory, 'credits.ass');
		const image = path.join(directory, 'preview.png');
		await writeFile(file, ass);
		let offset = seconds;
		let mediaPath = item.playbackPath;
		for (const part of item.parts) {
			if (offset < (part.durationSeconds ?? 0)) {
				mediaPath = part.playbackPath;
				break;
			}
			offset -= part.durationSeconds ?? 0;
		}
		const width = channel.video.width ?? 1920;
		const height = channel.video.height ?? 1080;
		const fonts = channel.subtitleFontsFolder ? `:fontsdir='${filterPath(channel.subtitleFontsFolder)}'` : '';
		const scale = channel.video.scalingMode === 'stretch' ? `scale=${width}:${height}`
			: channel.video.scalingMode === 'crop' ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
				: `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
		const filter = `${scale},setpts=PTS-STARTPTS+${seconds}/TB,subtitles='${filterPath(file)}'${fonts}`;
		try {
			await execute(channel.ffmpegPath ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(offset), '-i', mediaPath,
				'-vf', filter, '-frames:v', '1', '-threads', '1', image], { timeout: 30_000, maxBuffer: 1_048_576 });
		}
		catch {
			throw new Error('Unable to render the credit preview; check the video, fonts, and FFmpeg configuration');
		}
		return { ass, image: `data:image/png;base64,${(await readFile(image)).toString('base64')}` };
	}
	finally {
		await rm(directory, { recursive: true, force: true });
	}
}
