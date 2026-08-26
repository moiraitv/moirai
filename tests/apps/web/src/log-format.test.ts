import { describe, expect, it } from 'vitest';
import { requestDurationLabel } from '@web/log-format';

describe('log formatting', () => {
	it('uses compact precision in the log list', () => {
		expect(requestDurationLabel(null, 'compact')).toBe('—');
		expect(requestDurationLabel(0.25, 'compact')).toBe('0.25 ms');
		expect(requestDurationLabel(25.25, 'compact')).toBe('25.3 ms');
		expect(requestDurationLabel(1_250, 'compact')).toBe('1.25 s');
	});

	it('uses explicit units and detail precision in the log modal', () => {
		expect(requestDurationLabel(null, 'detail')).toBe('Unavailable');
		expect(requestDurationLabel(25.25, 'detail')).toBe('25.25 ms');
		expect(requestDurationLabel(1_250, 'detail')).toBe('1.250 seconds');
	});
});
