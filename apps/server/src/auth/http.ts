import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isLoopbackHostname, type AppConfig } from '../config.js';
import type { AuthenticationSessionRecord } from './contracts.js';
import {
	AUTHENTICATION_COOKIE,
	AuthenticationRequestError,
	type AuthenticationService,
} from './service.js';

declare module 'fastify' {
	/** Authentication state attached to one Fastify request by the central guard. */
	interface FastifyRequest {
		/** Resolved administrator session, when the opaque cookie is valid. */
		authenticationSession: AuthenticationSessionRecord | null;
		/** Stable bearer awaiting one final validity check before refreshing the browser cookie. */
		authenticationRefreshToken: string | null;
	}

	/** Route-level override for the default protected management API boundary. */
	interface FastifyContextConfig {
		/** Select public, optionally resolved, or required authentication for one route. */
		authentication?: 'public' | 'optional' | 'required';
	}
}

/** HTTP methods that can safely omit synchronizer-token validation. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Browser policy that prevents every Moirai response from being embedded by another page. */
const FRAME_ANCESTORS_POLICY = "frame-ancestors 'none'";
/** Private cache policy applied to management and authentication-sensitive responses. */
const PRIVATE_RESPONSE_CACHE_CONTROL = 'private, no-store';

/** Set one hardened administrator-session cookie after issuing or validating its bearer. */
export function setAuthenticationSessionCookie(
	reply: FastifyReply,
	token: string,
	expiresAt: string,
	config: AppConfig,
): void {
	const remainingSeconds = Math.max(
		0,
		Math.ceil((Date.parse(expiresAt) - Date.now()) / 1_000),
	);
	reply.setCookie(AUTHENTICATION_COOKIE, token, {
		httpOnly: true,
		sameSite: 'lax',
		secure: new URL(config.publicUrl).protocol === 'https:',
		path: '/',
		maxAge: remainingSeconds,
	});
}

/** Remove the administrator-session cookie without depending on stored session validity. */
export function clearAuthenticationSessionCookie(reply: FastifyReply, config: AppConfig): void {
	reply.clearCookie(AUTHENTICATION_COOKIE, {
		httpOnly: true,
		sameSite: 'lax',
		secure: new URL(config.publicUrl).protocol === 'https:',
		path: '/',
	});
}

/** Compare two CSRF bearer values without leaking a matching prefix through timing. */
function csrfMatches(actual: string | undefined, expected: string): boolean {
	if (!actual) {
		return false;
	}

	const actualBuffer = Buffer.from(actual);
	const expectedBuffer = Buffer.from(expected);
	return actualBuffer.length === expectedBuffer.length
		&& timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Return whether a browser origin is a configured application origin or loopback development host. */
function allowedOrigin(origin: string, config: AppConfig): boolean {
	try {
		const parsed = new URL(origin);
		if (parsed.origin === config.publicUrl || parsed.origin === config.managementUrl) {
			return true;
		}

		const serverHostIsLoopback = isLoopbackHostname(config.host);
		const originIsLoopback = isLoopbackHostname(parsed.hostname);
		return serverHostIsLoopback && originIsLoopback;
	}
	catch {
		return false;
	}
}

/** Return whether one canonical API route can carry administrator or authentication state. */
function requiresPrivateResponse(request: FastifyRequest): boolean {
	const route = request.routeOptions.url;
	if (!route?.startsWith('/api/v1/')) {
		return false;
	}

	const authenticationMode = request.routeOptions.config.authentication ?? 'required';
	return authenticationMode !== 'public' || route.startsWith('/api/v1/auth/');
}

/** Register session resolution, management-route protection, origin checks, and CSRF enforcement. */
export function registerAuthenticationGuard(
	app: FastifyInstance,
	authentication: AuthenticationService,
	config: AppConfig,
): void {
	app.decorateRequest('authenticationSession', null);
	app.decorateRequest('authenticationRefreshToken', null);
	app.addHook('onRequest', async (request) => {
		// Use the matched template because Fastify routes decoded paths while request.url stays raw.
		if (!request.routeOptions.url?.startsWith('/api/v1/')) {
			return;
		}

		const authenticationMode = request.routeOptions.config.authentication ?? 'required';
		const origin = request.headers.origin;
		const isWebSocketUpgrade = request.headers.upgrade?.toLowerCase() === 'websocket';
		if (
			(!SAFE_METHODS.has(request.method) || isWebSocketUpgrade)
			&& origin
			&& !allowedOrigin(origin, config)
		) {
			throw new AuthenticationRequestError(
				'Request origin is not allowed',
				403,
				'csrf_rejected',
			);
		}
		if (request.method === 'OPTIONS') {
			return;
		}

		if (authenticationMode === 'public') {
			return;
		}

		const cookieToken = request.cookies[AUTHENTICATION_COOKIE];
		const resolution = await authentication.resolveRequestSession(
			cookieToken,
			!isWebSocketUpgrade,
		);
		request.authenticationSession = resolution.record;
		request.authenticationRefreshToken = resolution.refreshToken;

		if (authenticationMode === 'optional') {
			return;
		}
		if (!request.authenticationSession) {
			throw new AuthenticationRequestError(
				'Authentication is required',
				401,
				'authentication_required',
			);
		}

		if (!SAFE_METHODS.has(request.method)) {
			const csrf = request.headers['x-moirai-csrf'];
			if (typeof csrf !== 'string'
				|| !csrfMatches(csrf, request.authenticationSession.csrfToken)) {
				throw new AuthenticationRequestError(
					'CSRF token is invalid',
					403,
					'csrf_rejected',
				);
			}
		}
	});
	app.addHook('onSend', async (request, reply, payload) => {
		// Prevent UI redressing and shared-cache reuse before completing session renewal work.
		reply.header('Content-Security-Policy', FRAME_ANCESTORS_POLICY);
		reply.header('X-Frame-Options', 'DENY');
		if (requiresPrivateResponse(request)) {
			reply.header('Cache-Control', PRIVATE_RESPONSE_CACHE_CONTROL);
		}

		const refreshToken = request.authenticationRefreshToken;
		const expiresAt = request.authenticationSession?.expiresAt;
		if (!refreshToken || !expiresAt) {
			return payload;
		}

		try {
			if (await authentication.sessionTokenIsActive(refreshToken)) {
				setAuthenticationSessionCookie(
					reply,
					refreshToken,
					expiresAt,
					config,
				);
			}
		}
		catch (error) {
			request.log.warn(
				{ errorType: error instanceof Error ? error.name : 'UnknownError' },
				'Unable to validate a renewed authentication cookie',
			);
		}

		return payload;
	});
}

/** Require the resolved session in handlers whose guard has already enforced authentication. */
export function authenticatedSession(request: FastifyRequest): AuthenticationSessionRecord {
	if (!request.authenticationSession) {
		throw new AuthenticationRequestError(
			'Authentication is required',
			401,
			'authentication_required',
		);
	}

	return request.authenticationSession;
}
