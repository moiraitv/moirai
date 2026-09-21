import audit from './fixtures/duration-audit.json';
import { describe, expect, it, vi } from 'vitest';
import { parseMediaProbeOutput } from '@server/media/media-probe.js';
import {
	MEDIA_DURATION_MISMATCH_TOLERANCE_MILLISECONDS,
	SILENT_TAIL_AUDIO_ALIGNMENT_TOLERANCE_MILLISECONDS,
	mediaDurationHealthIssues,
	withinDurationTolerance,
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


it('requires nearby audio endings and a single real video track for silent-tail acceptance', () => {
	const probe = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ codec_type: 'video', duration: '100', start_time: '0' },
		{ codec_type: 'video', duration: '200', disposition: { attached_pic: 1 } },
		{ codec_type: 'audio', duration: '60', start_time: '0' },
		{ codec_type: 'audio', duration: '60.02', start_time: '0' },
	] }), 1);
	expect(probe.durationMilliseconds).toBe(100_000);
	expect(silentTailTarget(probe)).toMatchObject({ durationSeconds: 40, timingKnown: true });
	probe.streams[3]!.durationMilliseconds = 60_000 + SILENT_TAIL_AUDIO_ALIGNMENT_TOLERANCE_MILLISECONDS;
	expect(silentTailTarget(probe)).toMatchObject({ startSeconds: 60, durationSeconds: 40, timingKnown: true });
	probe.streams[3]!.durationMilliseconds += 1;
	expect(silentTailTarget(probe)).toBeNull();
	probe.streams[3]!.durationMilliseconds = 150_000;
	expect(silentTailTarget(probe)).toBeNull();
	probe.streams[3]!.durationMilliseconds = 60_000;
	probe.streams[1]!.isAttachedPicture = false;
	expect(silentTailTarget(probe)).toBeNull();
});

it('suppresses Black Panther without inspecting its tail', async () => {
	const probe = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ index: 1, codec_type: 'video', duration: '8106.598333', start_time: '0.043333' },
		...['8071.571667', '8071.615000', '8071.613333', '8071.613333', '8080.573333']
			.map((duration, index) => ({ index: index + 2, codec_type: 'audio', duration, start_time: '0' })),
	] }), 1);
	const inspect = vi.fn(async () => 'mostly-black' as const);
	const findings = await assessDurationHealth(probe, {
		root: '/', file: '/film.m4v', relativePath: 'film.m4v', fingerprint: 'file', cached: undefined,
		inspect, signal: undefined,
	});
	expect(inspect).not.toHaveBeenCalled();
	expect(findings[0]?.tailAssessment?.result).toBe('within-duration-tolerance');
});

it('requires a warning-sized earliest gap and measured audio ending before the video', () => {
	const video = 100_000;
	const earliest = video - MEDIA_DURATION_MISMATCH_TOLERANCE_MILLISECONDS;
	const probe = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ codec_type: 'video', duration: video / 1_000, start_time: '0' },
		{ codec_type: 'audio', duration: earliest / 1_000, start_time: '0' },
	] }), 1);
	expect(silentTailTarget(probe)).toBeNull();
	probe.streams[1]!.durationMilliseconds = earliest - 1;
	expect(silentTailTarget(probe)).not.toBeNull();
	probe.streams.push({ ...probe.streams[1]!, index: 2, durationMilliseconds: video });
	expect(silentTailTarget(probe)).toBeNull();
	probe.streams[2]!.durationMilliseconds = video + 1;
	expect(silentTailTarget(probe)).toBeNull();
	probe.streams[2]!.durationMilliseconds = null;
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


it.each([
	[[950, 1030], true], [[949.999, 1000], false], [[950, 1030.001], false],
	[[980, 800], false], [[null, 950], true], [[null], false],
])('checks every measured duration at the exact percentage and padding boundaries (%j)', (durations, eligible) => {
	const probe = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ codec_type: 'video', duration: 1000, start_time: 3 },
		...durations.map(duration => ({ codec_type: 'audio', duration, start_time: 24 })),
	] }), 1);
	expect(withinDurationTolerance(probe)).toBe(eligible);
});

it.each(['not-black', 'uncertain', 'mostly-black'] as const)('skips inspection and cached %s for percentage-qualified files', async result => {
	const probe = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ codec_type: 'video', duration: 1000 }, { codec_type: 'audio', duration: 950, start_time: 24 },
	] }), 1);
	const inspect = vi.fn(async () => 'not-black' as const);
	const findings = await assessDurationHealth(probe, {
		root: '/', file: '/film', relativePath: 'film', fingerprint: 'identity',
		cached: { fingerprint: 'identity', result, accepted: false }, inspect, signal: undefined,
	});
	expect(findings[0]?.tailAssessment?.result).toBe('within-duration-tolerance');
	expect(inspect).not.toHaveBeenCalled();
});

it('uses visual inspection for larger eligible gaps even after a percentage assessment', async () => {
	const probe = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ codec_type: 'video', duration: 1000, start_time: 0 }, { codec_type: 'audio', duration: 940, start_time: 0 },
	] }), 1);
	const inspect = vi.fn(async () => 'mostly-black' as const);
	const findings = await assessDurationHealth(probe, {
		root: '/', file: '/film', relativePath: 'film', fingerprint: 'identity',
		cached: { fingerprint: 'identity', result: 'within-duration-tolerance', accepted: false }, inspect, signal: undefined,
	});
	expect(findings[0]?.tailAssessment?.result).toBe('mostly-black');
	expect(inspect).toHaveBeenCalledOnce();
});


it('leaves only the three audited outliers outside percentage tolerance', () => {
	const active = audit.filter(entry => !withinDurationTolerance(parseMediaProbeOutput(JSON.stringify({ streams: [
		{ codec_type: 'video', duration: entry.video },
		...entry.audio.map(duration => ({ codec_type: 'audio', duration })),
	] }), 1)));
	expect(active.map(entry => entry.title)).toEqual(['Stargate (1994)', 'The Elephant Man (1980)', 'Three Kings (1999)']);
});
