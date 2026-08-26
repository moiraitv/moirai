/** Return the readable message carried by an unknown caught value. */
export function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
