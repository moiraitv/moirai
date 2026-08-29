import type { ExternalAuthenticationIdentity } from './contracts.js';

/** Browser redirect plus server-side verifier state created for one external sign-in attempt. */
export interface ExternalSignInRequest {
	url: string;
	state: string;
	codeVerifier: string;
	nonce: string;
}

/** Provider logout notification identifiers used to revoke matching local sessions. */
export interface ExternalLogoutIdentity {
	issuer: string;
	jti: string;
	subject: string | null;
	sid: string | null;
}

/**
 * Boundary implemented by redirect-based administrator identity providers. The authentication
 * service owns local sessions while providers own protocol discovery and token validation.
 */
export interface AuthenticationProviderAdapter {
	readonly id: 'logto';
	createSignIn(redirectUri: string): Promise<ExternalSignInRequest>;
	completeSignIn(
		currentUrl: string,
		redirectUri: string,
		state: string,
		codeVerifier: string,
		nonce: string,
	): Promise<ExternalAuthenticationIdentity>;
	logoutUrl(encryptedHint: string | null, postLogoutRedirectUri: string): Promise<string | null>;
	validateBackchannelLogout(logoutToken: string): Promise<ExternalLogoutIdentity>;
}
