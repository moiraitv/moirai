import { describe, expect, it } from 'vitest';
import {
	accelerationFromWorkerLine,
	PlaybackClientTracker,
} from '@server/playback/session-observability.js';

describe('playback session observability', () => {
	it('derives actual acceleration from optimized worker encoders', () => {
		expect(accelerationFromWorkerLine(
			'optimized pipeline: -hwaccel videotoolbox -vcodec h264_videotoolbox -f hls',
		)).toBe('videotoolbox');
		expect(accelerationFromWorkerLine(
			'optimized pipeline: -init_hw_device cuda -vcodec hevc_nvenc -f hls',
		)).toBe('cuda');
		expect(accelerationFromWorkerLine(
			'optimized pipeline: -vcodec libx264 -f hls',
		)).toBe('none');
		expect(accelerationFromWorkerLine('ordinary worker diagnostic')).toBeNull();
	});

	it('deduplicates and expires bounded client observations', () => {
		const tracker = new PlaybackClientTracker();
		tracker.observe({ address: '192.0.2.1', userAgent: 'VLC\nClient' }, 1_000);
		tracker.observe({ address: '192.0.2.1', userAgent: 'VLC Client' }, 2_000);
		expect(tracker.active(2_000)).toEqual([{
			address: '192.0.2.1',
			userAgent: 'VLC Client',
			firstSeenAt: '1970-01-01T00:00:01.000Z',
			lastSeenAt: '1970-01-01T00:00:02.000Z',
		}]);
		expect(tracker.active(92_001)).toEqual([]);
	});

	it('retains only the sixteen most recently observed client identities', () => {
		const tracker = new PlaybackClientTracker();
		for (let index = 0; index < 17; index += 1) {
			tracker.observe({ address: `192.0.2.${index}`, userAgent: null }, index);
		}
		const active = tracker.active(17);
		expect(active).toHaveLength(16);
		expect(active.some((client) => client.address === '192.0.2.0')).toBe(false);
	});

	it('starts a new viewing duration when an expired identity returns', () => {
		const tracker = new PlaybackClientTracker();
		tracker.observe({ address: '192.0.2.1', userAgent: 'VLC' }, 1_000);
		tracker.observe({ address: '192.0.2.1', userAgent: 'VLC' }, 92_001);
		expect(tracker.active(92_001)).toEqual([{
			address: '192.0.2.1',
			userAgent: 'VLC',
			firstSeenAt: '1970-01-01T00:01:32.001Z',
			lastSeenAt: '1970-01-01T00:01:32.001Z',
		}]);
	});
});
