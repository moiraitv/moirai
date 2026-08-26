/** Return the current UTC time as an ISO-8601 timestamp. */
export function currentTimestamp(): string {
	return new Date().toISOString();
}
