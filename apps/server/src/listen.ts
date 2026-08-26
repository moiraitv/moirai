/** Retry limits for a development-server port handoff. */
export interface ListenRetryOptions {
	attempts: number;
	delayMs: number;
	onRetry?: (attempt: number, error: NodeJS.ErrnoException) => void;
}

/** Return whether Node reported that the requested listening address is still occupied. */
function addressInUse(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

/** Retry the short port-release race caused by development watcher restarts. */
export async function listenWithAddressRetry(
	listen: () => Promise<void>,
	options: ListenRetryOptions,
): Promise<void> {
	for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
		try {
			await listen();
			return;
		}
		catch (error) {
			if (!addressInUse(error) || attempt === options.attempts) {
				throw error;
			}

			options.onRetry?.(attempt, error);
			await new Promise((resolve) => setTimeout(resolve, options.delayMs));
		}
	}
}
