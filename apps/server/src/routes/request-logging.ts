import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';

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

/** Match routine polls without hiding mutations or nearby routes. */
function isRoutinePollingRead(request: FastifyRequest): boolean {
	if (request.method !== 'GET') {
		return false;
	}
	const endpoint = request.url.split(/[?#]/, 1)[0] ?? '';
	return endpoint === '/api/v1/health/ready' || endpoint === '/api/v1/playback/status'
		|| /^\/api\/v1\/ai\/generations\/[^/]+$/u.test(endpoint);
}

/** Suppress successful polls while retaining failed requests and server errors. */
export class RoutineRequestLogController extends LogController {
	constructor() {
		super({ disableRequestLogging: request => suppressRoutineRequestLog(request.method, request.url) });
	}

	/** Omit the start record because a polling response usually succeeds. */
	override incomingRequest(request: FastifyRequest, reply: FastifyReply, metadata?: Record<string, unknown>): void {
		if (!isRoutinePollingRead(request)) {
			super.incomingRequest(request, reply, metadata);
		}
	}

	/** Keep completion records when the status read fails or returns an error status. */
	override requestCompleted(
		error: Error | null | undefined,
		request: FastifyRequest,
		reply: FastifyReply,
		metadata?: Record<string, unknown>,
	): void {
		if (!isRoutinePollingRead(request) || error || reply.statusCode >= 400) {
			super.requestCompleted(error, request, reply, metadata);
		}
	}
}
