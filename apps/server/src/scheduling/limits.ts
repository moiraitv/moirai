/** Report a preview whose media granularity exceeds the segment resource limit. */
export class TimelineMaterializationLimitError extends Error {
	readonly statusCode = 422;

	constructor(readonly limit: number) {
		super(`Timeline preview exceeds the ${limit.toLocaleString('en-US')} segment limit`);
		this.name = 'TimelineMaterializationLimitError';
	}
}

