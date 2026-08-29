import { describe, expect, it } from 'vitest';
import { captureRecoveryFragment } from '@web/recovery-fragment.js';

describe('authentication recovery fragment', () => {
	it('retains the recovery source while authentication bootstrap is unavailable', () => {
		expect(captureRecoveryFragment('#token=single-use-code', false)).toEqual({
			token: 'single-use-code',
			clearFragment: false,
		});
	});

	it('clears a captured recovery fragment after successful bootstrap', () => {
		expect(captureRecoveryFragment('#token=single-use-code', true)).toEqual({
			token: 'single-use-code',
			clearFragment: true,
		});
	});

	it('does not clear unrelated or empty fragments', () => {
		expect(captureRecoveryFragment('#section=account', true)).toEqual({
			token: '',
			clearFragment: false,
		});
	});
});
