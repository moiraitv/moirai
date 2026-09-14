import { ApiError } from './api';

/** Only transport failures and temporary gateway/service responses justify automatic read retries. */
export function isTransientReadFailure(cause: unknown): boolean {
	return cause instanceof ApiError ? [502, 503, 504].includes(cause.status) : cause instanceof TypeError;
}

/** Retry one failed read once; callers must never pass mutations to this helper. */
export async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	}
	catch (cause) {
		if (!isTransientReadFailure(cause)) {
			throw cause;
		}
		return read();
	}
}
