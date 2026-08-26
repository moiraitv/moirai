/** Bounded delays used between consecutive development API restart attempts. */
export const API_CRASH_RESTART_DELAYS_MS = Object.freeze([250, 500, 1_000, 2_000, 5_000]);

/** Return a bounded delay for a zero-based consecutive API crash attempt. */
export function apiCrashRestartDelay(attempt) {
	const normalizedAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
	const index = Math.min(normalizedAttempt, API_CRASH_RESTART_DELAYS_MS.length - 1);
	return API_CRASH_RESTART_DELAYS_MS[index];
}
