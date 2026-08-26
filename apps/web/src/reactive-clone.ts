/** Clone JSON-compatible API contract data while safely traversing Vue proxies at any depth. */
export function cloneContractValue<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
