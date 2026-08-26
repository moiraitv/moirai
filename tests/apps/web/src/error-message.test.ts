import { describe, expect, it } from 'vitest';
import { errorMessage } from '@web/error-message';

describe('error messages', () => {
	it('uses an Error message without exposing its stack', () => {
		expect(errorMessage(new Error('Request failed'))).toBe('Request failed');
	});

	it('preserves readable non-Error rejection values', () => {
		expect(errorMessage('Connection closed')).toBe('Connection closed');
		expect(errorMessage(null)).toBe('null');
	});
});
