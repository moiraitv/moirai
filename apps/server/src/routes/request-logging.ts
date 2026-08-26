/** Read-only log endpoints polled by the Logs page itself. */
const QUIET_REQUEST_ENDPOINTS = new Set(['/api/v1/logs', '/api/v1/logs/files']);

/** Suppress routine access records that would otherwise make the Logs page observe itself. */
export function suppressRoutineRequestLog(method: string, url: string): boolean {
	if (method.toUpperCase() !== 'GET') {
		return false;
	}

	const endpoint = url.split(/[?#]/, 1)[0] ?? '';
	return QUIET_REQUEST_ENDPOINTS.has(endpoint);
}
