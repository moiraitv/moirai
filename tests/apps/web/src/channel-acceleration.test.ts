import { describe, expect, it } from 'vitest';
import { formatHardwareAccelerationPrediction } from '@web/channel-acceleration';

describe('hardware acceleration prediction text', () => {
	it('describes loading, hardware, fallback, and indeterminate states compactly', () => {
		expect(formatHardwareAccelerationPrediction(undefined, true)).toBe(
			'Checking…',
		);
		expect(formatHardwareAccelerationPrediction({
			outcome: 'hardware',
			accel: 'videotoolbox',
			detail: 'available',
		}, false)).toBe('VideoToolbox');
		expect(formatHardwareAccelerationPrediction({
			outcome: 'none',
			accel: null,
			detail: 'unsupported',
		}, false)).toBe('None');
		expect(formatHardwareAccelerationPrediction({
			outcome: 'indeterminate',
			accel: null,
			detail: 'unavailable',
		}, false)).toBe(
			'Undetermined',
		);
	});
});
