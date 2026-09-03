/** Error shape used by the API client to retain a safe public response body. */
interface ErrorWithPublicBody extends Error {
	body?: {
		code?: unknown;
		requestId?: unknown;
	};
}

/** Return the readable message carried by an unknown caught value. */
export function errorMessage(value: unknown): string {
	if (!(value instanceof Error)) {
		return String(value);
	}

	const publicError = value as ErrorWithPublicBody;
	const requestId = publicError.body?.requestId;
	if (
		publicError.body?.code === 'internal_error'
		&& typeof requestId === 'string'
		&& requestId.length > 0
		&& requestId.length <= 128
	) {
		return `${value.message}. Check server logs for request ${requestId}.`;
	}

	return value.message;
}
