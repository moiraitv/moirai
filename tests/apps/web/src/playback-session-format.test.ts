import { describe, expect, it } from 'vitest';
import {
	playbackAccelerationLabel,
	playbackClientDurationLabel,
	playbackPositionIndicator,
} from '@web/playback-session-format';

describe('playback session formatting', () => {
	it('formats acceleration for the session status column', () => {
		expect(playbackAccelerationLabel('videotoolbox')).toBe('VideoToolbox');
		expect(playbackAccelerationLabel('none')).toBe('None');
		expect(playbackAccelerationLabel('pending')).toBe('Determining…');
	});

	it('formats client time on channel from its first observation', () => {
		const start = '2026-08-27T17:00:00.000Z';
		expect(playbackClientDurationLabel(start, Date.parse(start) + 42_000)).toBe('42s');
		expect(playbackClientDurationLabel(start, Date.parse(start) + 12 * 60_000)).toBe('12m');
		expect(playbackClientDurationLabel(start, Date.parse(start) + 3_720_000)).toBe('1h 2m');
	});

	it('derives and clamps the current program position', () => {
		const item = {
			title: 'Current program',
			artworkUrl: null,
			startedAt: '2026-08-27T17:00:00.000Z',
			finishesAt: '2026-08-27T18:30:00.000Z',
		};
		const position = playbackPositionIndicator(item, Date.parse('2026-08-27T17:45:30.000Z'));
		expect(position).toMatchObject({
			elapsed: '45:30',
			duration: '1:30:00',
		});
		expect(position?.percent).toBeCloseTo(50.556, 3);
		expect(playbackPositionIndicator(item, Date.parse('2026-08-27T19:00:00.000Z'))).toEqual({
			elapsed: '1:30:00',
			duration: '1:30:00',
			percent: 100,
		});
	});

	it('rejects invalid current program intervals', () => {
		expect(playbackPositionIndicator({
			title: 'Invalid',
			artworkUrl: null,
			startedAt: '2026-08-27T18:00:00.000Z',
			finishesAt: '2026-08-27T17:00:00.000Z',
		})).toBeNull();
	});
});
