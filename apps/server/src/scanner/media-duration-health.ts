import type { ScanIssue } from '@moirai/shared';
import type { MediaProbeResult } from '../media/media-probe.js';

/** Allow up to thirty seconds of padding or track-end differences without a warning. */
export const MEDIA_DURATION_MISMATCH_TOLERANCE_MILLISECONDS = 30_000;

/** Report measured audio tracks that differ materially from the scheduled video duration. */
export function mediaDurationHealthIssues(probe: MediaProbeResult, relativePath: string): ScanIssue[] {
	const mismatched = probe.streams.filter((stream) => stream.type === 'audio'
		&& stream.durationMilliseconds !== null
		&& Math.abs(stream.durationMilliseconds - probe.durationMilliseconds)
		> MEDIA_DURATION_MISMATCH_TOLERANCE_MILLISECONDS);
	if (mismatched.length === 0) {
		return [];
	}

	const audio = mismatched.map((stream) =>
		`#${stream.index}: ${(stream.durationMilliseconds! / 1_000).toFixed(3)}s`).join(', ');
	return [{
		path: relativePath,
		code: 'media_audio_video_duration_mismatch',
		severity: 'warning',
		message: `Audio/video durations differ: video ${(probe.durationMilliseconds / 1_000).toFixed(3)}s; audio ${audio}. Playback and scheduling use the video duration.`,
	}];
}
