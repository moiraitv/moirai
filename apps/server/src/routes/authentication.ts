import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
	authenticationReturnQuerySchema,
	authenticationStateSchema,
	localAuthenticationCredentialsSchema,
	localAuthenticationLoginSchema,
	localAuthenticationRecoverySchema,
	localAuthenticationSetupSchema,
} from '@moirai/shared/api-contracts';
import type { AppConfig } from '../config.js';
import {
	authenticatedSession,
	clearAuthenticationSessionCookie,
	setAuthenticationSessionCookie,
} from '../auth/http.js';
import {
	OIDC_BINDING_COOKIE,
	OIDC_TRANSACTION_TTL_MS,
	type AuthenticationService,
} from '../auth/service.js';
import {
	apiOperation,
	emptyResponseSchema,
	responseContent,
} from './contracts.js';

/** Query fields returned by one OIDC authorization callback. */
const oidcCallbackQuerySchema = z.object({
	state: z.string().min(1).max(2_048),
	code: z.string().min(1).max(8_192).optional(),
	error: z.string().max(512).optional(),
});

/** Form-encoded Logto back-channel logout notification. */
const backchannelLogoutSchema = z.object({ logout_token: z.string().min(1).max(32_768) });
/** Request-body allowance for the bounded logout token plus its form field name. */
const BACKCHANNEL_LOGOUT_BODY_LIMIT_BYTES = 34 * 1_024;

/** Local or provider logout destination returned after the local cookie is cleared. */
const logoutResponseSchema = z.object({ redirectUrl: z.string().url().nullable() });

/** Resolve one validated application path against the browser-facing management origin. */
function managementLocation(path: string, config: AppConfig): string {
	return new URL(path, `${config.managementUrl}/`).href;
}

/** Set the short-lived HttpOnly cookie that binds one browser to its OIDC transaction. */
function setOidcBindingCookie(reply: FastifyReply, token: string, config: AppConfig): void {
	reply.setCookie(OIDC_BINDING_COOKIE, token, {
		httpOnly: true,
		sameSite: 'lax',
		secure: new URL(config.publicUrl).protocol === 'https:',
		path: '/api/v1/auth/logto/callback',
		maxAge: Math.floor(OIDC_TRANSACTION_TTL_MS / 1_000),
	});
}

/** Remove the OIDC transaction binding after either callback success or failure. */
function clearOidcBindingCookie(reply: FastifyReply, config: AppConfig): void {
	reply.clearCookie(OIDC_BINDING_COOKIE, {
		httpOnly: true,
		sameSite: 'lax',
		secure: new URL(config.publicUrl).protocol === 'https:',
		path: '/api/v1/auth/logto/callback',
	});
}

/** Register initialization, local-session, recovery, and Logto authentication operations. */
export function registerAuthenticationRoutes(
	app: FastifyInstance,
	config: AppConfig,
	authentication: AuthenticationService,
): void {
	app.get('/api/v1/auth/session', {
		config: { authentication: 'optional' },
		schema: apiOperation({
			operationId: 'getAuthenticationSession',
			tags: ['Authentication'],
			summary: 'Read initialization and administrator-session state',
			authentication: 'public',
			response: { 200: responseContent('Current authentication state', 'application/json', authenticationStateSchema) },
			errors: [500, 503],
		}),
	}, async (request, reply) => {
		reply.header('Cache-Control', 'no-store');
		return authentication.state(request.authenticationSession);
	});

	app.post('/api/v1/auth/setup', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'setupLocalAuthentication',
			tags: ['Authentication'],
			summary: 'Claim an uninitialized installation with a local administrator',
			authentication: 'public',
			body: localAuthenticationSetupSchema,
			response: { 201: responseContent('Authenticated administrator session', 'application/json', authenticationStateSchema) },
			errors: [400, 409, 429, 500, 503],
		}),
	}, async (request, reply) => {
		const input = localAuthenticationSetupSchema.parse(request.body);
		const issued = await authentication.setupLocal(input, request.ip);
		setAuthenticationSessionCookie(reply, issued.token, issued.record.expiresAt, config);
		return reply.status(201).send(await authentication.state(issued.record));
	});

	app.post('/api/v1/auth/login', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'loginLocalAuthentication',
			tags: ['Authentication'],
			summary: 'Create an administrator session with local credentials',
			authentication: 'public',
			body: localAuthenticationLoginSchema,
			response: { 200: responseContent('Authenticated administrator session', 'application/json', authenticationStateSchema) },
			errors: [400, 401, 429, 500, 503],
		}),
	}, async (request, reply) => {
		const input = localAuthenticationLoginSchema.parse(request.body);
		const issued = await authentication.loginLocal(input, request.ip);
		setAuthenticationSessionCookie(reply, issued.token, issued.record.expiresAt, config);
		return authentication.state(issued.record);
	});

	app.put('/api/v1/auth/local-credentials', {
		schema: apiOperation({
			operationId: 'saveLocalAuthenticationCredentials',
			tags: ['Authentication'],
			summary: 'Create or replace the singleton local administrator credentials',
			body: localAuthenticationCredentialsSchema,
			response: { 200: responseContent('Rotated authenticated session', 'application/json', authenticationStateSchema) },
			errors: [400, 401, 403, 409, 429, 500, 503],
		}),
	}, async (request, reply) => {
		const session = authenticatedSession(request);
		const input = localAuthenticationCredentialsSchema.parse(request.body);
		const issued = await authentication.saveLocalCredentials(input, session);
		setAuthenticationSessionCookie(reply, issued.token, issued.record.expiresAt, config);
		return authentication.state(issued.record);
	});

	app.post('/api/v1/auth/recover', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'recoverLocalAuthentication',
			tags: ['Authentication'],
			summary: 'Create or replace local credentials with an operator recovery code',
			authentication: 'public',
			body: localAuthenticationRecoverySchema,
			response: { 200: responseContent('Recovered administrator session', 'application/json', authenticationStateSchema) },
			errors: [400, 401, 429, 500, 503],
		}),
	}, async (request, reply) => {
		const input = localAuthenticationRecoverySchema.parse(request.body);
		const issued = await authentication.recoverLocal(input.token, input, request.ip);
		setAuthenticationSessionCookie(reply, issued.token, issued.record.expiresAt, config);
		return authentication.state(issued.record);
	});

	app.post('/api/v1/auth/logout', {
		schema: apiOperation({
			operationId: 'logoutAuthenticationSession',
			tags: ['Authentication'],
			summary: 'Revoke the current local and provider sessions',
			response: { 200: responseContent('Optional provider logout redirect', 'application/json', logoutResponseSchema) },
			errors: [401, 403, 500, 503],
		}),
	}, async (request, reply) => {
		const session = authenticatedSession(request);
		const redirectUrl = await authentication.logout(session);
		clearAuthenticationSessionCookie(reply, config);
		return { redirectUrl };
	});

	app.get('/api/v1/auth/logto/start', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'startLogtoAuthentication',
			tags: ['Authentication'],
			summary: 'Redirect to the configured Logto application',
			authentication: 'public',
			querystring: authenticationReturnQuerySchema,
			response: { 302: responseContent('Redirect to Logto', 'application/octet-stream', emptyResponseSchema) },
			errors: [400, 404, 429, 500, 503],
		}),
	}, async (request, reply) => {
		const query = authenticationReturnQuerySchema.parse(request.query);
		const started = await authentication.beginLogto(query.returnTo, request.ip);
		setOidcBindingCookie(reply, started.bindingToken, config);
		return reply.redirect(started.url);
	});

	app.get('/api/v1/auth/logto/callback', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'completeLogtoAuthentication',
			tags: ['Authentication'],
			summary: 'Validate a Logto callback and establish an administrator session',
			authentication: 'public',
			querystring: oidcCallbackQuerySchema,
			response: { 302: responseContent('Redirect to the authenticated UI', 'application/octet-stream', emptyResponseSchema) },
			errors: [400, 401, 500, 503],
		}),
	}, async (request, reply) => {
		const bindingToken = request.cookies[OIDC_BINDING_COOKIE];
		clearOidcBindingCookie(reply, config);
		try {
			const query = oidcCallbackQuerySchema.parse(request.query);
			if (query.error || !query.code) {
				return reply.redirect(managementLocation('/login?error=oidc', config));
			}

			const completed = await authentication.completeLogto(
				new URL(request.url, config.publicUrl).href,
				query.state,
				bindingToken,
			);
			setAuthenticationSessionCookie(
				reply,
				completed.session.token,
				completed.session.record.expiresAt,
				config,
			);
			return reply.redirect(managementLocation(completed.returnTo, config));
		}
		catch (error) {
			request.log.warn(
				{ errorType: error instanceof Error ? error.name : 'UnknownError' },
				'Logto authentication callback failed',
			);
			return reply.redirect(managementLocation('/login?error=oidc', config));
		}
	});

	app.post('/api/v1/auth/logto/backchannel-logout', {
		bodyLimit: BACKCHANNEL_LOGOUT_BODY_LIMIT_BYTES,
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'receiveLogtoBackchannelLogout',
			tags: ['Authentication'],
			summary: 'Revoke sessions identified by a validated Logto logout token',
			authentication: 'public',
			consumes: ['application/x-www-form-urlencoded'],
			body: backchannelLogoutSchema,
			response: { 204: responseContent('Matching sessions revoked', 'application/octet-stream', emptyResponseSchema) },
			errors: [400, 401, 413, 500, 503],
		}),
	}, async (request, reply) => {
		const input = backchannelLogoutSchema.parse(request.body);
		await authentication.backchannelLogout(input.logout_token);
		return reply.status(204).send();
	});
}
