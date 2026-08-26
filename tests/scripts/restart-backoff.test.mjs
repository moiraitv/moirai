import { describe, expect, it } from 'vitest';

import { API_CRASH_RESTART_DELAYS_MS, apiCrashRestartDelay } from '@scripts/restart-backoff.mjs';

describe('API crash restart backoff', () => {
	it('uses each configured delay in order', () => {
		const observed = API_CRASH_RESTART_DELAYS_MS.map((_delay, attempt) =>
			apiCrashRestartDelay(attempt));

		expect(observed).toEqual(API_CRASH_RESTART_DELAYS_MS);
	});

	it('caps repeated failures at the longest configured delay', () => {
		const finalDelay = API_CRASH_RESTART_DELAYS_MS.at(-1);

		expect(apiCrashRestartDelay(API_CRASH_RESTART_DELAYS_MS.length + 20)).toBe(finalDelay);
	});

	it('normalizes invalid attempts to the first configured delay', () => {
		const firstDelay = API_CRASH_RESTART_DELAYS_MS[0];

		expect(apiCrashRestartDelay(-1)).toBe(firstDelay);
		expect(apiCrashRestartDelay(Number.NaN)).toBe(firstDelay);
	});
});
