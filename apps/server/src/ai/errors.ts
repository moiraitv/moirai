/** Application-authored AI failure safe to display without exposing upstream bodies or secrets. */
export class AiSelectionError extends Error {}

/** A complete provider reply that could not satisfy a validated selection contract. */
export class AiInvalidSelectionError extends AiSelectionError {}

/** A generation that reached its configured hard deadline. */
export class AiTimeoutError extends AiSelectionError {}

/** A provider HTTP failure with a safe status code for recovery decisions. */
export class AiProviderHttpError extends AiSelectionError {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

/** An HTTP 200 envelope can still carry a provider error with a safe numeric status. */
export class AiProviderPayloadError extends AiSelectionError {
	constructor(readonly status: number | null) {
		super('The AI provider could not complete this request. Generate again.');
	}
}

/** Safe categories for provider and validation failures. */
export type AiFailureCategory = 'invalid-selection' | 'timeout' | 'authorization' | 'configuration' | 'rate-limit' | 'provider' | 'transport' | 'other';

/** Classify failure causes without retaining upstream response content or credentials. */
export function aiFailureCategory(cause: unknown): AiFailureCategory {
	if (cause instanceof AiTimeoutError) {
		return 'timeout';
	}
	if (cause instanceof AiInvalidSelectionError) {
		return 'invalid-selection';
	}
	if (cause instanceof AiProviderPayloadError) {
		return cause.status === 401 || cause.status === 403 ? 'authorization'
			: cause.status !== null && cause.status >= 400 && cause.status < 500 && cause.status !== 429
				? 'configuration' : cause.status === 429 ? 'rate-limit' : 'provider';
	}
	if (cause instanceof AiProviderHttpError) {
		return [401, 403].includes(cause.status) ? 'authorization'
			: cause.status === 429 ? 'rate-limit'
				: cause.status >= 400 && cause.status < 500 ? 'configuration' : 'provider';
	}
	if (cause instanceof Error && ['TimeoutError', 'AbortError'].includes(cause.name)) {
		return 'timeout';
	}
	if (cause instanceof TypeError) {
		return 'transport';
	}
	if (cause instanceof AiSelectionError) {
		return 'provider';
	}
	return 'other';
}

/** Publish model guidance and replace every other failure with generic wording. */
export function selectionFailure(cause: unknown): Error {
	const message = cause instanceof AiSelectionError ? cause.message : 'Generation failed. Try again.';
	return Object.assign(new Error(message), { statusCode: 422, expose: true });
}
