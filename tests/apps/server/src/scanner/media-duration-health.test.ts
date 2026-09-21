import { describe, expect, it } from 'vitest';
import { parseMediaProbeOutput } from '@server/media/media-probe.js';
import {
	MEDIA_DURATION_MISMATCH_TOLERANCE_MILLISECONDS,
	mediaDurationHealthIssues,
	assessDurationHealth,
	silentTailTarget,
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

	it('ignores tolerated track differences, unknown audio durations, and long subtitles', () => {
		const probe = parseMediaProbeOutput(JSON.stringify({
			streams: [
				{ codec_type: 'video', duration: videoSeconds },
				{ codec_type: 'audio', duration: videoSeconds + 5 },
				{ codec_type: 'audio', duration: videoSeconds - 5 },
				{ codec_type: 'audio', duration: videoSeconds + toleranceSeconds },
				{ codec_type: 'audio', duration: videoSeconds - toleranceSeconds },
				{ codec_type: 'audio' },
				{ codec_type: 'subtitle', duration: videoSeconds * 2 },
			],
		}), 1);

		expect(mediaDurationHealthIssues(probe, 'movie.mp4')).toEqual([]);
	});
});


it('requires joint audio endings and a single real video track for silent-tail acceptance', () => {
	const probe = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ codec_type: 'video', duration: '100', start_time: '0' },
		{ codec_type: 'video', duration: '200', disposition: { attached_pic: 1 } },
		{ codec_type: 'audio', duration: '60', start_time: '0' },
		{ codec_type: 'audio', duration: '60.02', start_time: '0' },
	] }), 1);
	expect(probe.durationMilliseconds).toBe(100_000);
	expect(silentTailTarget(probe)).toMatchObject({ durationSeconds: 40, timingKnown: true });
	probe.streams[3]!.durationMilliseconds = 65_000;
	expect(silentTailTarget(probe)).toBeNull();
	probe.streams[3]!.durationMilliseconds = 150_000;
	expect(silentTailTarget(probe)).toBeNull();
});

it('keeps a tail with unknown timing uncertain without trying to inspect it', async () => {
	const probe = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ codec_type: 'video', duration: '100' }, { codec_type: 'audio', duration: '60' },
	] }), 1);
	const findings = await assessDurationHealth(probe, {
		root: '/', file: '/unused', relativePath: 'unused', fingerprint: 'identity', cached: undefined,
		inspect: async () => {
			throw new Error('must not inspect unknown timing');
		}, signal: undefined,
	});
	expect(findings[0]?.tailAssessment).toEqual({ fingerprint: 'identity', result: 'uncertain', accepted: false });
});
