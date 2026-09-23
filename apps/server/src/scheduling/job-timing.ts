import { AsyncLocalStorage } from 'node:async_hooks';

/** Fixed phase names keep diagnostics bounded and exclude user-authored values. */
export type JobPhase = 'read' | 'compute' | 'serialize';
/** Aggregated worker phase durations sent separately from public response data. */
export type JobTimings = Partial<Record<JobPhase, number>>;
/** Isolate concurrent local fallback timing scopes as well as serial worker jobs. */
const scope = new AsyncLocalStorage<JobTimings>();

/** Collect operation phases without retaining catalogs or request contents. */
export async function timedJob<T>(operation: () => Promise<T>): Promise<{ result: T; timings: JobTimings }> {
	const timings: JobTimings = {};
	const result = await scope.run(timings, operation);
	return { result, timings };
}

/** Add one completed phase to the current worker timing scope. */
export function recordJobPhase(phase: JobPhase, durationMs: number): void {
	const timings = scope.getStore();
	if (timings) {
		timings[phase] = (timings[phase] ?? 0) + durationMs;
	}
}

/** Time synchronous CPU work, including schema validation and serialization. */
export function timePhase<T>(phase: JobPhase, operation: () => T): T {
	const started = performance.now();
	try {
		return operation();
	}
	finally {
		const timings = scope.getStore();
		if (timings) {
			timings[phase] = (timings[phase] ?? 0) + performance.now() - started;
		}
	}
}

/** Time a read or rendering phase that can yield between its synchronous chunks. */
export async function timeAsyncPhase<T>(phase: JobPhase, operation: () => Promise<T>): Promise<T> {
	const started = performance.now();
	try {
		return await operation();
	}
	finally {
		const timings = scope.getStore();
		if (timings) {
			timings[phase] = (timings[phase] ?? 0) + performance.now() - started;
		}
	}
}
