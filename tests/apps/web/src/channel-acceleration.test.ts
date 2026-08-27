import { describe, expect, it } from 'vitest';
import { formatHardwareAccelerationPrediction } from '@web/channel-acceleration';

describe('hardware acceleration prediction text', () => {
	it('describes loading, hardware, fallback, and indeterminate states compactly', () => {
		expect(formatHardwareAccelerationPrediction(undefined, true)).toBe(
			'Checking available hardware…',
		);
		expect(formatHardwareAccelerationPrediction({
			outcome: 'hardware',
			accel: 'videotoolbox',
			detail: 'available',
		}, false)).toBe('Likely resolves to VideoToolbox.');
		expect(formatHardwareAccelerationPrediction({
			outcome: 'none',
			accel: null,
			detail: 'unsupported',
		}, false)).toBe('No compatible hardware detected; Automatic will use None.');
		expect(formatHardwareAccelerationPrediction({
			outcome: 'indeterminate',
			accel: null,
			detail: 'unavailable',
		}, false)).toBe(
			'Unable to predict; playback will retry, then use None if still indeterminate.',
		);
	});
});
