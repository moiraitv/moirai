import type { AuthenticationIdentity } from '@moirai/shared';

/** Persisted local identity fields required for password verification and credential changes. */
export interface LocalAuthenticationIdentity extends AuthenticationIdentity {
	provider: 'local';
	username: string;
	passwordHash: string;
}

/** Persisted session and identity data resolved from one opaque browser token. */
export interface AuthenticationSessionRecord {
	tokenHash: string;
	identity: AuthenticationIdentity;
	csrfToken: string;
	providerSessionId: string | null;
	providerLogoutHint: string | null;
	providerConfigurationHash: string | null;
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
}

/** Short-lived OIDC verifier state consumed exactly once by a valid callback. */
export interface OidcTransactionRecord {
	stateHash: string;
	bindingHash: string;
	codeVerifier: string;
	nonce: string;
	returnTo: string;
	logoutGeneration: number;
	expiresAt: string;
}

/** Validated external identity used to establish a local administrator session. */
export interface ExternalAuthenticationIdentity {
	issuer: string;
	subject: string;
	displayName: string;
	providerSessionId: string | null;
	providerLogoutHint: string | null;
}
