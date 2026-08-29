import { describe, expect, it } from 'vitest';
import { AuthenticationRateLimiter } from '@server/auth/rate-limiter.js';

describe('authentication rate limiter', () => {
	it('reserves overlapping attempts before their expensive work completes', () => {
		const limiter = new AuthenticationRateLimiter(2, 1_000, 10);
		expect(limiter.reserve('client', 100)).toBe(true);
		expect(limiter.reserve('client', 100)).toBe(true);
		expect(limiter.reserve('client', 100)).toBe(false);

		limiter.succeed('client');
		expect(limiter.reserve('client', 100)).toBe(true);
	});
});
