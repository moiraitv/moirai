/** Quantize elapsed seconds once for timeline arithmetic; Infinity retains unbounded budgets. */
export function durationMilliseconds(seconds: number): number {
	return Math.round(seconds * 1_000);
}

/** Subtract source endpoints at their stored millisecond precision before accumulating spans. */
export function spanDurationMilliseconds(startSeconds: number, finishSeconds: number): number {
	return durationMilliseconds(finishSeconds) - durationMilliseconds(startSeconds);
}

/** Compare validated millisecond-backed instants independently of ISO precision or timezone spelling. */
export function compareInstants(left: string, right: string): number {
	return Date.parse(left) - Date.parse(right);
}

/**
 * Resolve a validated inclusive lower or exclusive upper bound for millisecond-backed records.
 * Ceil any finer fraction so both comparisons retain their meaning, including before the epoch.
 * Read the remainder as digits because Date.parse discards precision beyond milliseconds.
 */
export function timestampBoundaryMilliseconds(value: string): number {
	const remainder = /\.\d{3}(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '';
	return Date.parse(value) + (/[1-9]/.test(remainder) ? 1 : 0);
}
