/** Extract an internal diagnostic message from an unknown caught value. */
export function internalErrorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
