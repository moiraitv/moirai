import { afterEach, expect, it } from 'vitest';
import {
	applicationError,
	clearApplicationError,
	recordApplicationError,
} from '@web/application-error.js';

afterEach(() => {
	clearApplicationError();
});

it('records a readable message without requiring an Error instance', () => {
	recordApplicationError(new Error('Render failed'));
	expect(applicationError.value).toBe('Render failed');
	recordApplicationError('Broken view');
	expect(applicationError.value).toBe('Broken view');
	clearApplicationError();
	expect(applicationError.value).toBeNull();
});
