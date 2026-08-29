/** One bounded authentication-attempt counter retained only in process memory. */
interface AttemptWindow {
	count: number;
	startedAt: number;
}

/** Failed authentication attempts accepted for one key during a limiter window. */
export const AUTHENTICATION_MAX_ATTEMPTS = 5;

/**
 * Bound repeated password and recovery guesses without creating persistent per-request writes. Old
 * counters are pruned opportunistically and the oldest entry is removed at the map limit.
 */
export class AuthenticationRateLimiter {
	private readonly attempts = new Map<string, AttemptWindow>();

	constructor(
		private readonly maximumAttempts = AUTHENTICATION_MAX_ATTEMPTS,
		private readonly windowMs = 15 * 60 * 1_000,
		private readonly maximumKeys = 5_000,
	) {}

	/** Atomically reserve one attempt so overlapping guesses count before expensive work begins. */
	reserve(key: string, now = Date.now()): boolean {
		const current = this.attempts.get(key);
		if (!current || now - current.startedAt >= this.windowMs) {
			this.attempts.set(key, { count: 1, startedAt: now });
			this.enforceKeyLimit();
			return true;
		}

		if (current.count >= this.maximumAttempts) {
			return false;
		}

		current.count += 1;
		return true;
	}

	/** Evict the oldest counter after the configured memory bound is exceeded. */
	private enforceKeyLimit(): void {
		if (this.attempts.size > this.maximumKeys) {
			const oldest = this.attempts.keys().next().value as string | undefined;
			if (oldest) {
				this.attempts.delete(oldest);
			}
		}
	}

	/** Clear prior failures after a successful authentication operation. */
	succeed(key: string): void {
		this.attempts.delete(key);
	}
}
