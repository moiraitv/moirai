import type { PlaybackNowPlayingStatus, PlaybackSessionAcceleration } from '@moirai/shared';

/** Display-ready elapsed time, duration, and bounded percentage for a current program. */
export interface PlaybackPositionIndicator {
	elapsed: string;
	duration: string;
	percent: number;
}

/** Format whole elapsed seconds as a compact clock without dropping hour boundaries. */
function playbackClockLabel(totalSeconds: number): string {
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
		: `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Format one observed encoder backend for the active-session list. */
export function playbackAccelerationLabel(acceleration: PlaybackSessionAcceleration): string {
	const labels: Record<PlaybackSessionAcceleration, string> = {
		amf: 'AMF',
		cuda: 'CUDA',
		qsv: 'QSV',
		rkmpp: 'RKMPP',
		vaapi: 'VAAPI',
		videotoolbox: 'VideoToolbox',
		vulkan: 'Vulkan',
		none: 'None',
		pending: 'Determining…',
	};
	return labels[acceleration];
}

/** Format how long one client has continuously been observed on a channel. */
export function playbackClientDurationLabel(firstSeenAt: string, nowMs = Date.now()): string {
	const elapsedSeconds = Math.max(0, Math.floor((nowMs - Date.parse(firstSeenAt)) / 1_000));
	if (elapsedSeconds < 60) {
		return `${elapsedSeconds}s`;
	}

	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) {
		return `${elapsedMinutes}m`;
	}

	const hours = Math.floor(elapsedMinutes / 60);
	const minutes = elapsedMinutes % 60;
	return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** Derive a clamped wall-clock position within the committed program interval. */
export function playbackPositionIndicator(
	item: PlaybackNowPlayingStatus,
	nowMs = Date.now(),
): PlaybackPositionIndicator | null {
	const startedAtMs = Date.parse(item.startedAt);
	const finishesAtMs = Date.parse(item.finishesAt);
	const durationMs = finishesAtMs - startedAtMs;
	if (!Number.isFinite(startedAtMs) || !Number.isFinite(finishesAtMs) || durationMs <= 0) {
		return null;
	}

	const elapsedMs = Math.min(durationMs, Math.max(0, nowMs - startedAtMs));
	const elapsedSeconds = Math.floor(elapsedMs / 1_000);
	const durationSeconds = Math.max(1, Math.ceil(durationMs / 1_000));
	return {
		elapsed: playbackClockLabel(elapsedSeconds),
		duration: playbackClockLabel(durationSeconds),
		percent: elapsedMs / durationMs * 100,
	};
}
