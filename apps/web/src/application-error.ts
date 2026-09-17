import { ref } from 'vue';
import { errorMessage } from './error-message';

/** Last uncaught Vue render failure shown in place of the current view. */
export const applicationError = ref<string | null>(null);

/** Record a render failure for the in-app error page without putting it in the URL. */
export function recordApplicationError(error: unknown): void {
	applicationError.value = errorMessage(error);
}

/** Dismiss the in-app error page and restore the current route view. */
export function clearApplicationError(): void {
	applicationError.value = null;
}
