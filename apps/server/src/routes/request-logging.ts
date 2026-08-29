/** Read-only endpoints omitted from routine request logs for noise or credential safety. */
const QUIET_REQUEST_ENDPOINTS = new Set([
	'/api/v1/auth/logto/callback',
	'/api/v1/logs',
	'/api/v1/logs/files',
]);

/** Suppress routine access records that are noisy or may carry temporary credentials in the URL. */
export function suppressRoutineRequestLog(method: string, url: string): boolean {
	if (method.toUpperCase() !== 'GET') {
		return false;
	}

	const endpoint = url.split(/[?#]/, 1)[0] ?? '';
	return QUIET_REQUEST_ENDPOINTS.has(endpoint);
}
