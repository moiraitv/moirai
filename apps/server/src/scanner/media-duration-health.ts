import type { BlackTailTarget, BlackTailResult } from '../media/black-tail.js';
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

/** Only jointly ending audio tracks can be accepted as a harmless silent ending. */
export function silentTailTarget(probe: MediaProbeResult) {
	const audio = probe.streams.filter(stream => stream.type === 'audio');
	const video = probe.streams.filter(stream => stream.type === 'video' && !stream.isAttachedPicture);
	if (video.length !== 1 || !audio.length || audio.some(stream => stream.durationMilliseconds === null)) {
		return null;
	}
	const durations = audio.map(stream => stream.durationMilliseconds!);
	const earliest = Math.min(...durations);
	const latest = Math.max(...durations);
	if (latest - earliest > 1_000
		|| probe.durationMilliseconds - latest <= MEDIA_DURATION_MISMATCH_TOLERANCE_MILLISECONDS) {
		return null;
	}
	const timingKnown = audio.every(stream => stream.startMilliseconds === 0)
		&& video[0]!.startMilliseconds != null
		&& Math.abs(video[0]!.startMilliseconds) <= 1_000;
	return {
		streamIndex: video[0]!.index,
		startSeconds: earliest / 1_000,
		durationSeconds: (probe.durationMilliseconds + (video[0]!.startMilliseconds ?? 0) - earliest) / 1_000,
		timingKnown,
	};
}

/** Bounded inspector supplied by the existing media-probe queue. */
export type TailInspector = (root: string, file: string, target: BlackTailTarget, signal?: AbortSignal) => Promise<BlackTailResult>;

/** File identity, prior decision, and cancellation inputs for one scan finding. */
export interface DurationHealthContext {
	root: string;
	file: string;
	relativePath: string;
	fingerprint: string;
	cached: ScanIssue['tailAssessment'];
	inspect: TailInspector | undefined;
	signal: AbortSignal | undefined;
}

/** Reuse unchanged tail decisions or inspect a new candidate before publishing its finding. */
export async function assessDurationHealth(probe: MediaProbeResult, context: DurationHealthContext): Promise<ScanIssue[]> {
	const findings = mediaDurationHealthIssues(probe, context.relativePath);
	const target = silentTailTarget(probe);
	if (findings.length && target) {
		findings[0]!.tailAssessment = context.cached?.fingerprint === context.fingerprint ? context.cached : {
			fingerprint: context.fingerprint,
			result: target.timingKnown && context.inspect
				? await context.inspect(context.root, context.file, { ...target, fingerprint: context.fingerprint }, context.signal)
				: 'uncertain',
			accepted: false,
		};
	}
	return findings;
}
