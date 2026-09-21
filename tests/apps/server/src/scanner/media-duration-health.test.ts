import { describe, expect, it } from 'vitest';
import { parseMediaProbeOutput } from '@server/media/media-probe.js';
import {
	MEDIA_DURATION_MISMATCH_TOLERANCE_MILLISECONDS,
	mediaDurationHealthIssues,
} from '@server/scanner/media-duration-health.js';

describe('media duration health', () => {
	const videoSeconds = 60;
	const toleranceSeconds = MEDIA_DURATION_MISMATCH_TOLERANCE_MILLISECONDS / 1_000;

	it.each([-1, 1])('warns for audio shorter or longer than video (direction %s)', (direction) => {
		const probe = parseMediaProbeOutput(JSON.stringify({
			streams: [
				{ codec_type: 'video', duration: videoSeconds },
				{ codec_type: 'audio', duration: videoSeconds + direction * (toleranceSeconds + 1) },
				{ codec_type: 'audio', duration: videoSeconds + direction * (toleranceSeconds + 2) },
			],
		}), 1);

		const issues = mediaDurationHealthIssues(probe, 'movie.mp4');
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			code: 'media_audio_video_duration_mismatch', severity: 'warning', path: 'movie.mp4',
		});
		expect(issues[0]!.message).toContain('#1:');
		expect(issues[0]!.message).toContain('#2:');
	});

	it('ignores encoder padding, unknown audio durations, and long subtitles', () => {
		const probe = parseMediaProbeOutput(JSON.stringify({
			streams: [
				{ codec_type: 'video', duration: videoSeconds },
				{ codec_type: 'audio', duration: videoSeconds + toleranceSeconds },
				{ codec_type: 'audio', duration: videoSeconds - toleranceSeconds },
				{ codec_type: 'audio' },
				{ codec_type: 'subtitle', duration: videoSeconds * 2 },
			],
		}), 1);

		expect(mediaDurationHealthIssues(probe, 'movie.mp4')).toEqual([]);
	});
});
