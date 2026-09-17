/** Return the current UTC time as an ISO-8601 timestamp. */
export function currentTimestamp(): string {
	return new Date().toISOString();
}

/** Return control to the event loop so health probes can run during long work. */
export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}
