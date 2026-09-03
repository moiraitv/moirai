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

	it('adds the safe request identifier to unexpected API failures', () => {
		const failure = Object.assign(new Error('An unexpected server error occurred'), {
			body: { code: 'internal_error', requestId: 'req-channels-17' },
		});

		expect(errorMessage(failure)).toBe(
			'An unexpected server error occurred. Check server logs for request req-channels-17.',
		);
	});
});
