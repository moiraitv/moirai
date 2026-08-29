import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import {
	authorizationCodeGrant,
	allowInsecureRequests,
	buildAuthorizationUrl,
	buildEndSessionUrl,
	calculatePKCECodeChallenge,
	discovery,
	randomNonce,
	randomPKCECodeVerifier,
	randomState,
	type Configuration,
} from 'openid-client';
import type { LogtoConfig } from '../config.js';
import { decryptProviderHint, encryptProviderHint } from './crypto.js';
import type {
	AuthenticationProviderAdapter,
	ExternalLogoutIdentity,
	ExternalSignInRequest,
} from './provider.js';
import type { ExternalAuthenticationIdentity } from './contracts.js';

/** OIDC back-channel event claim required by the logout-token specification. */
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/** Typed subset of provider logout-token claims used for local session revocation. */
interface LogoutTokenPayload extends JWTPayload {
	events?: Record<string, unknown>;
	sid?: string;
}

/**
 * Authenticate administrators through one configured Logto traditional-web application. Discovery
 * and signing keys remain cached while every authorization response is bound to PKCE, state, and
 * nonce values owned by Moirai.
 */
export class LogtoAuthenticationProvider implements AuthenticationProviderAdapter {
	readonly id = 'logto' as const;
	private configurationPromise: Promise<Configuration> | null = null;
	private keySet: ReturnType<typeof createRemoteJWKSet> | null = null;

	constructor(private readonly config: LogtoConfig) {}

	/** Build one Logto authorization redirect with fresh anti-replay values. */
	async createSignIn(redirectUri: string): Promise<ExternalSignInRequest> {
		const configuration = await this.configuration();
		const state = randomState();
		const nonce = randomNonce();
		const codeVerifier = randomPKCECodeVerifier();
		const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
		const url = buildAuthorizationUrl(configuration, {
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: 'openid profile email',
			state,
			nonce,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
		});

		return { url: url.href, state, nonce, codeVerifier };
	}

	/** Validate one authorization callback and normalize its stable external identity. */
	async completeSignIn(
		currentUrl: string,
		redirectUri: string,
		state: string,
		codeVerifier: string,
		nonce: string,
	): Promise<ExternalAuthenticationIdentity> {
		const configuration = await this.configuration();
		const tokens = await authorizationCodeGrant(configuration, new URL(currentUrl), {
			pkceCodeVerifier: codeVerifier,
			expectedState: state,
			expectedNonce: nonce,
			idTokenExpected: true,
		}, { redirect_uri: redirectUri });
		const claims = tokens.claims();
		if (!claims?.sub || !claims.iss || !tokens.id_token) {
			throw new Error('Logto response did not contain a validated identity');
		}

		const displayName = [claims.name, claims.preferred_username, claims.email, claims.sub]
			.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
			?? claims.sub;
		return {
			issuer: claims.iss,
			subject: claims.sub,
			displayName: displayName.slice(0, 200),
			providerSessionId: typeof claims.sid === 'string' ? claims.sid : null,
			providerLogoutHint: encryptProviderHint(tokens.id_token, this.config.appSecret),
		};
	}

	/** Build a Logto end-session redirect when the encrypted ID-token hint is still usable. */
	async logoutUrl(
		encryptedHint: string | null,
		postLogoutRedirectUri: string,
	): Promise<string | null> {
		if (!encryptedHint) {
			return null;
		}

		const idTokenHint = decryptProviderHint(encryptedHint, this.config.appSecret);
		if (!idTokenHint) {
			return null;
		}

		const configuration = await this.configuration();
		return buildEndSessionUrl(configuration, {
			id_token_hint: idTokenHint,
			post_logout_redirect_uri: postLogoutRedirectUri,
		}).href;
	}

	/** Verify one Logto back-channel logout token before exposing its revocation identifiers. */
	async validateBackchannelLogout(logoutToken: string): Promise<ExternalLogoutIdentity> {
		const configuration = await this.configuration();
		const metadata = configuration.serverMetadata();
		if (!metadata.jwks_uri || !metadata.issuer) {
			throw new Error('Logto discovery metadata does not expose signing keys');
		}

		this.keySet ??= createRemoteJWKSet(
			new URL(metadata.jwks_uri),
			{ timeoutDuration: 10_000 },
		);
		const verified = await jwtVerify<LogoutTokenPayload>(logoutToken, this.keySet, {
			issuer: metadata.issuer,
			audience: this.config.appId,
			maxTokenAge: '10 minutes',
			clockTolerance: 5,
		});
		const payload = verified.payload;
		if (
			typeof payload.jti !== 'string'
			|| payload.jti.length === 0
			|| payload.jti.length > 2_048
			|| payload.nonce !== undefined
			|| !payload.events
			|| !(BACKCHANNEL_LOGOUT_EVENT in payload.events)
			|| (typeof payload.sub !== 'string' && typeof payload.sid !== 'string')
		) {
			throw new Error('Invalid Logto back-channel logout claims');
		}

		return {
			issuer: metadata.issuer,
			jti: payload.jti,
			subject: typeof payload.sub === 'string' ? payload.sub : null,
			sid: typeof payload.sid === 'string' ? payload.sid : null,
		};
	}

	/** Discover and cache Logto metadata with a bounded protocol request timeout. */
	private async configuration(): Promise<Configuration> {
		if (!this.configurationPromise) {
			const endpoint = new URL(this.config.endpoint);
			this.configurationPromise = discovery(
				new URL(`${this.config.endpoint}/oidc`),
				this.config.appId,
				this.config.appSecret,
				undefined,
				{
					timeout: 10,
					...(endpoint.protocol === 'http:' ? { execute: [allowInsecureRequests] } : {}),
				},
			).then((configuration) => {
				configuration.timeout = 10;
				return configuration;
			}).catch((error) => {
				this.configurationPromise = null;
				throw error;
			});
		}

		return this.configurationPromise;
	}
}
