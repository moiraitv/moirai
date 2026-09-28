/** Application-authored AI failure safe to display without exposing upstream bodies or secrets. */
export class AiSelectionError extends Error {}

/** Publish model guidance and replace every other failure with generic wording. */
export function selectionFailure(cause: unknown): Error {
	const message = cause instanceof AiSelectionError ? cause.message : 'Generation failed. Try again.';
	return Object.assign(new Error(message), { statusCode: 422, expose: true });
}
