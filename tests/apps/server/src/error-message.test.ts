import { describe, expect, it } from 'vitest';
import { internalErrorMessage } from '@server/error-message.js';

describe('internal error messages', () => {
	it('extracts Error messages and stringifies other thrown values', () => {
		expect(internalErrorMessage(new Error('Scan failed'))).toBe('Scan failed');
		expect(internalErrorMessage('Connection closed')).toBe('Connection closed');
	});
});
