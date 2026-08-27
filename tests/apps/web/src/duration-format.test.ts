import { describe, expect, it } from 'vitest';
import { compactDurationLabel } from '@web/duration-format';

describe('compact duration formatting', () => {
	it('carries rounded minutes into hours', () => {
		expect(compactDurationLabel(7_170, 'Unknown')).toBe('2h');
		expect(compactDurationLabel(5_430, 'Unknown')).toBe('1h 31m');
	});

	it('keeps short positive clips visible and preserves the unavailable label', () => {
		expect(compactDurationLabel(1, 'Unknown')).toBe('1m');
		expect(compactDurationLabel(null, 'Unknown')).toBe('Unknown');
	});
});
