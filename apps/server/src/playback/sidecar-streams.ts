import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { MediaSubtitleTrack } from '@moirai/shared';

/** Bound FFprobe execution and output without invoking a shell. */
const execute = promisify(execFile);
/** Validate the stream fields used to select a concrete sidecar subtitle. */
const streamsSchema = z.object({
	streams: z.array(z.object({
		index: z.number().int().nonnegative(),
		tags: z.object({ language: z.string().optional() }).optional(),
		disposition: z.object({ default: z.number().optional(), forced: z.number().optional() }).optional(),
	})),
});

/** Expose each sidecar stream as a track for normal language and disposition selection. */
export async function probeSidecarStreams(
	file: string,
	track: MediaSubtitleTrack,
	ffprobePath: string,
): Promise<MediaSubtitleTrack[]> {
	const { stdout } = await execute(ffprobePath, [
		'-v', 'error', '-select_streams', 's', '-show_entries',
		'stream=index:stream_tags=language:stream_disposition=default,forced', '-of', 'json', file,
	], { timeout: 30_000, maxBuffer: 1_048_576 });
	const document = streamsSchema.parse(JSON.parse(stdout));
	return document.streams.map((stream) => ({
		...track,
		streamIndex: stream.index,
		language: stream.tags?.language ?? track.language,
		isDefault: stream.disposition?.default === 1 || track.isDefault,
		isForced: stream.disposition?.forced === 1 || track.isForced,
	}));
}
