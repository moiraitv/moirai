import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type {
	AuthenticationIdentity,
	AuthenticationState,
} from '@moirai/shared';
import { localAuthenticationUsernameSchema } from '@moirai/shared/api-contracts';
import type { AppConfig } from '../config.js';
import type { Repository } from '../repository/index.js';
import { currentTimestamp } from '../time.js';
import type { AuthenticationSessionRecord } from './contracts.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from './crypto.js';
import type {
	AuthenticationProviderAdapter,
	ExternalLogoutIdentity,
	ExternalSignInRequest,
} from './provider.js';
import { AuthenticationRateLimiter } from './rate-limiter.js';

/** Name of the opaque administrator-session cookie. */
export const AUTHENTICATION_COOKIE = 'moirai_session';
/** Thirty-day inactivity limit for administrator browser sessions. */
export const AUTHENTICATION_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
/** Absolute lifetime of one Logto-backed administrator session. */
export const OIDC_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
/** Sliding local-session extensions occur at most once per day per active browser. */
const SESSION_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
/** Active browser sessions retained for one administrator identity. */
export const MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY = 32;
/** Active browser sessions retained across the complete installation. */
export const MAX_AUTHENTICATION_SESSIONS = 1_024;
/** OIDC verifier state remains valid only for a short browser redirect. */
export const OIDC_TRANSACTION_TTL_MS = 10 * 60 * 1_000;
/** Name of the short-lived cookie binding one browser to its OIDC transaction. */
export const OIDC_BINDING_COOKIE = 'moirai_oidc_binding';
/** Maximum OIDC redirects one client may begin during one limiter window. */
export const OIDC_START_MAX_ATTEMPTS = 10;
/** Global bound on unconsumed OIDC redirect state retained in SQLite. */
export const OIDC_TRANSACTION_LIMIT = 256;
/** Operator-issued local recovery codes remain valid for fifteen minutes. */
const RECOVERY_TOKEN_TTL_MS = 15 * 60 * 1_000;
/** Bound memory-hard password operations to the default worker-pool capacity. */
const MAX_CONCURRENT_PASSWORD_OPERATIONS = 4;
/** Bound signature verification work accepted from the public provider logout endpoint. */
export const MAX_CONCURRENT_LOGOUT_VERIFICATIONS = 8;
/** Bound provider exchanges accepted from valid public OIDC callback transactions. */
export const MAX_CONCURRENT_OIDC_COMPLETIONS = 8;
/** Provider logout fingerprints remain useful only for the accepted token-age window. */
const OIDC_LOGOUT_TOKEN_TTL_MS = 10 * 60 * 1_000;
/** Bound valid provider logout fingerprints retained during their replay window. */
export const OIDC_LOGOUT_TOKEN_LIMIT = 4_096;

/** Credentials accepted when creating or replacing the singleton local administrator. */
export interface LocalCredentials {
	username: string;
	password: string;
}

/** Newly issued browser-session bearer and its resolved safe record. */
export interface IssuedAuthenticationSession {
	token: string;
	record: AuthenticationSessionRecord;
}

/** Session resolution plus the stable local bearer whose browser lifetime should be refreshed. */
export interface ResolvedAuthenticationSession {
	record: AuthenticationSessionRecord | null;
	refreshToken: string | null;
}

/** Observer notified when durable session invalidation ends access or requests replacement. */
export type AuthenticationSessionRevocationListener = (
	tokenHashes: readonly string[],
	reason: 'ended' | 'replaced',
) => void;

/** Expected safe authentication failure mapped through the stable public error envelope. */
export class AuthenticationRequestError extends Error {
	readonly expose = true;

	constructor(
		message: string,
		readonly statusCode: 401 | 403 | 404 | 409 | 429 | 503,
		readonly code: string,
	) {
		super(message);
	}
}

/** Canonicalize a local username for case-insensitive lookup and uniqueness. */
function usernameKey(value: string): string {
	return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

/** Identify the non-secret OIDC application context that authorized provider sessions. */
function oidcConfigurationHash(config: AppConfig): string | null {
	if (!config.logto) {
		return null;
	}

	return hashToken(`logto\0${config.logto.endpoint}\0${config.logto.appId}`);
}

/** Retain only same-origin relative routes across local and external sign-in redirects. */
export function safeAuthenticationReturnPath(value: string | undefined): string {
	if (!value || !value.startsWith('/') || value.startsWith('//')) {
		return '/';
	}

	try {
		const parsed = new URL(value, 'https://moirai.invalid');
		return parsed.origin === 'https://moirai.invalid'
			? `${parsed.pathname}${parsed.search}${parsed.hash}`
			: '/';
	}
	catch {
		return '/';
	}
}

/**
 * Own administrator initialization, credential verification, local sessions, provider redirects,
 * recovery, and logout synchronization. HTTP concerns remain in the authentication route plugin.
 */
export class AuthenticationService {
	private readonly limiter = new AuthenticationRateLimiter();
	private readonly oidcLimiter = new AuthenticationRateLimiter(OIDC_START_MAX_ATTEMPTS);
	private readonly sessionRevocationListeners = new Set<AuthenticationSessionRevocationListener>();
	private readonly providerConfigurationHash: string | null;
	private activePasswordOperations = 0;
	private activeLogoutVerifications = 0;
	private activeOidcCompletions = 0;
	private pruneTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly repository: Repository,
		private readonly config: AppConfig,
		private readonly logger: FastifyBaseLogger,
		private readonly provider: AuthenticationProviderAdapter | null,
	) {
		this.providerConfigurationHash = oidcConfigurationHash(config);
	}

	/** Reconcile provider sessions, then prune expired state now and every six hours. */
	async start(): Promise<void> {
		const revokedTokenHashes = await this.repository.authentication
			.revokeLogtoSessionsForConfiguration(this.providerConfigurationHash);
		this.notifySessionRevocations(revokedTokenHashes);
		await this.prune();
		this.pruneTimer = setInterval(() => {
			void this.prune().catch((error) => {
				this.logger.warn({ err: error }, 'Unable to prune expired authentication state');
			});
		}, 6 * 60 * 60 * 1_000);
		this.pruneTimer.unref();
	}

	/** Stop periodic authentication maintenance during application shutdown. */
	close(): void {
		if (this.pruneTimer) {
			clearInterval(this.pruneTimer);
			this.pruneTimer = null;
		}
	}

	/** Observe durable session revocations so stateful transports can disconnect immediately. */
	subscribeSessionRevocations(listener: AuthenticationSessionRevocationListener): () => void {
		this.sessionRevocationListeners.add(listener);
		return () => this.sessionRevocationListeners.delete(listener);
	}

	/** Return public initialization and method state, including one resolved browser session. */
	async state(session: AuthenticationSessionRecord | null): Promise<AuthenticationState> {
		const [initialized, local] = await Promise.all([
			this.repository.authentication.initialized(),
			this.repository.authentication.localIdentity(),
		]);
		return {
			status: session ? 'authenticated' : initialized ? 'anonymous' : 'uninitialized',
			methods: { local: Boolean(local), logto: Boolean(this.provider) },
			localUsername: session ? local?.username ?? null : null,
			identity: session?.identity ?? null,
			csrfToken: session?.csrfToken ?? null,
		};
	}

	/** Resolve an opaque cookie token without changing its durable or browser lifetime. */
	async resolveSession(token: string | undefined): Promise<AuthenticationSessionRecord | null> {
		if (!token || token.length > 512) {
			return null;
		}

		return this.repository.authentication.session(
			hashToken(token),
			currentTimestamp(),
		);
	}

	/** Resolve a request session and extend a local session's stable bearer once per active day. */
	async resolveRequestSession(
		token: string | undefined,
		allowRefresh: boolean,
	): Promise<ResolvedAuthenticationSession> {
		const record = await this.resolveSession(token);
		if (!record || !allowRefresh || record.identity.provider === 'logto' || !token) {
			return { record, refreshToken: null };
		}

		const nowMs = Date.now();
		if (nowMs - Date.parse(record.lastSeenAt) < SESSION_TOUCH_INTERVAL_MS) {
			return { record, refreshToken: null };
		}

		const lastSeenAt = new Date(nowMs).toISOString();
		const expiresAt = new Date(nowMs + AUTHENTICATION_SESSION_TTL_MS).toISOString();
		const touched = await this.repository.authentication.touchSession(
			record.tokenHash,
			lastSeenAt,
			expiresAt,
		);
		if (!touched) {
			return { record: null, refreshToken: null };
		}

		record.lastSeenAt = lastSeenAt;
		record.expiresAt = expiresAt;
		return { record, refreshToken: token };
	}

	/** Resolve the current expiry for a hashed session used by a long-lived transport. */
	async sessionExpiry(tokenHash: string): Promise<number | null> {
		const record = await this.repository.authentication.session(
			tokenHash,
			currentTimestamp(),
		);
		return record ? Date.parse(record.expiresAt) : null;
	}

	/** Return whether a prospective cookie refresh still names an active durable session. */
	async sessionTokenIsActive(token: string): Promise<boolean> {
		return Boolean(await this.resolveSession(token));
	}

	/** Claim an uninitialized installation with its singleton local administrator. */
	async setupLocal(
		credentials: LocalCredentials,
		remoteAddress: string,
	): Promise<IssuedAuthenticationSession> {
		const key = `setup:${remoteAddress}`;
		this.requireAttempt(key);
		if (await this.repository.authentication.initialized()) {
			throw new AuthenticationRequestError(
				'Initial account setup is already complete',
				409,
				'authentication_initialized',
			);
		}

		const normalized = this.normalizedLocalCredentials(credentials);
		const passwordHash = await this.passwordHash(credentials.password);
		const identity = await this.repository.authentication.claimInitialLocalIdentity({
			...normalized,
			passwordHash,
			displayName: normalized.username,
		}, currentTimestamp());
		if (!identity) {
			throw new AuthenticationRequestError(
				'Initial account setup is already complete',
				409,
				'authentication_initialized',
			);
		}

		const issued = await this.issueLocalSessionIfCurrent(identity, passwordHash);
		if (!issued) {
			throw new AuthenticationRequestError(
				'Initial account setup was superseded by another credential change',
				409,
				'authentication_changed',
			);
		}

		this.limiter.succeed(key);
		this.logger.info({ identityId: identity.id, provider: 'local' }, 'Authentication initialized');
		return issued;
	}

	/** Exchange valid local credentials for one revocable browser session. */
	async loginLocal(
		credentials: LocalCredentials,
		remoteAddress: string,
	): Promise<IssuedAuthenticationSession> {
		const normalizedKey = usernameKey(credentials.username);
		const attemptKey = `login-ip:${remoteAddress}`;
		this.requireAttempt(attemptKey);
		const local = await this.repository.authentication.localIdentity();
		let valid = false;
		if (local && usernameKey(local.username) === normalizedKey) {
			valid = await this.passwordMatches(credentials.password, local.passwordHash);
		}
		else {
			await this.consumeDummyPasswordWork(credentials.password);
		}
		if (!valid || !local) {
			throw new AuthenticationRequestError(
				'Invalid username or password',
				401,
				'invalid_credentials',
			);
		}

		const issued = await this.issueLocalSessionIfCurrent(local, local.passwordHash);
		if (!issued) {
			throw new AuthenticationRequestError(
				'Invalid username or password',
				401,
				'invalid_credentials',
			);
		}

		this.limiter.succeed(attemptKey);
		return issued;
	}

	/**
	 * Create or rotate local credentials, issue the initiating browser's replacement session, and
	 * distinguish its reconnect from terminal revocation of every other affected session.
	 */
	async saveLocalCredentials(
		credentials: LocalCredentials & { currentPassword: string | null },
		currentSession: AuthenticationSessionRecord,
	): Promise<IssuedAuthenticationSession> {
		const normalized = this.normalizedLocalCredentials(credentials);
		const local = await this.repository.authentication.localIdentity();
		if (local) {
			const attemptKey = `credentials:${currentSession.identity.id}`;
			this.requireAttempt(attemptKey);
			if (!credentials.currentPassword
				|| !await this.passwordMatches(credentials.currentPassword, local.passwordHash)) {
				throw new AuthenticationRequestError(
					'Current local password is incorrect',
					401,
					'invalid_credentials',
				);
			}
			this.limiter.succeed(attemptKey);
		}

		const passwordHash = await this.passwordHash(credentials.password);
		const now = currentTimestamp();
		const identityId = local?.id ?? randomUUID();
		const issued = this.newSession({
			id: identityId,
			provider: 'local',
			displayName: normalized.username,
			username: normalized.username,
		}, null, null);
		const replaced = await this.repository.authentication.replaceLocalIdentityAndSession(
			identityId,
			local?.passwordHash,
			{
				...normalized,
				passwordHash,
				displayName: normalized.username,
			},
			currentSession.tokenHash,
			this.sessionInput(issued.record),
			now,
			MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY,
			MAX_AUTHENTICATION_SESSIONS,
		);
		if (!replaced) {
			throw new AuthenticationRequestError(
				local
					? 'Current local credentials changed; verify them and try again'
					: 'Local credentials were created by another request; verify them and try again',
				local ? 401 : 409,
				local ? 'invalid_credentials' : 'authentication_changed',
			);
		}

		issued.record.identity = replaced.identity;
		// Close other revoked sessions promptly while retaining distinct initiating-client behavior.
		this.notifySessionRevocations(
			replaced.revokedTokenHashes.filter(
				(tokenHash) => tokenHash !== currentSession.tokenHash,
			),
		);
		this.notifySessionRevocations([currentSession.tokenHash], 'replaced');
		return issued;
	}

	/** Replace or create local credentials after consuming one operator-issued recovery code. */
	async recoverLocal(
		token: string,
		credentials: LocalCredentials,
		remoteAddress: string,
	): Promise<IssuedAuthenticationSession> {
		const key = `recover:${remoteAddress}`;
		this.requireAttempt(key);
		const normalized = this.normalizedLocalCredentials(credentials);
		const tokenHash = hashToken(token);
		if (!await this.repository.authentication.recoveryTokenActive(
			tokenHash,
			currentTimestamp(),
		)) {
			throw new AuthenticationRequestError(
				'Invalid or expired recovery code',
				401,
				'invalid_recovery_code',
			);
		}

		const passwordHash = await this.passwordHash(credentials.password);

		// Consume the operator authority before changing either identity or session state.
		const consumed = await this.repository.authentication.consumeRecoveryToken(
			tokenHash,
			currentTimestamp(),
		);
		if (!consumed) {
			throw new AuthenticationRequestError(
				'Invalid or expired recovery code',
				401,
				'invalid_recovery_code',
			);
		}

		// Replace existing credentials or resolve a fallback account created by a concurrent request.
		const now = currentTimestamp();
		const local = await this.repository.authentication.localIdentity();
		const localInput = {
			...normalized,
			passwordHash,
			displayName: normalized.username,
		};
		let identityId = local?.id ?? randomUUID();
		let issued = this.newSession({
			id: identityId,
			provider: 'local',
			displayName: normalized.username,
			username: normalized.username,
		}, null, null);
		let replaced = await this.repository.authentication.replaceLocalIdentityAndSession(
			identityId,
			local ? null : undefined,
			localInput,
			null,
			this.sessionInput(issued.record),
			now,
			MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY,
			MAX_AUTHENTICATION_SESSIONS,
		);
		if (!replaced && !local) {
			const concurrent = await this.repository.authentication.localIdentity();
			if (!concurrent) {
				throw new Error('Concurrent local identity creation did not persist an identity');
			}

			identityId = concurrent.id;
			issued = this.newSession({
				id: identityId,
				provider: 'local',
				displayName: normalized.username,
				username: normalized.username,
			}, null, null);
			replaced = await this.repository.authentication.replaceLocalIdentityAndSession(
				identityId,
				null,
				localInput,
				null,
				this.sessionInput(issued.record),
				now,
				MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY,
				MAX_AUTHENTICATION_SESSIONS,
			);
		}
		if (!replaced) {
			throw new Error('Local identity disappeared during credential recovery');
		}

		issued.record.identity = replaced.identity;
		this.notifySessionRevocations(replaced.revokedTokenHashes);

		this.limiter.succeed(key);
		this.logger.warn(
			{ identityId: replaced.identity.id },
			'Local administrator credentials recovered',
		);
		return issued;
	}

	/** Create one rate-limited, browser-bound OIDC redirect with globally bounded state. */
	async beginLogto(
		returnTo: string | undefined,
		remoteAddress: string,
	): Promise<{ url: string; bindingToken: string }> {
		if (!this.provider) {
			throw new AuthenticationRequestError('Logto is not configured', 404, 'not_found');
		}

		this.requireAttempt(`oidc-start:${remoteAddress}`, this.oidcLimiter);
		const logoutGeneration = await this.repository.authentication.oidcLogoutGeneration();
		const redirectUri = `${this.config.publicUrl}/api/v1/auth/logto/callback`;
		let request: ExternalSignInRequest;
		try {
			request = await this.provider.createSignIn(redirectUri);
		}
		catch (error) {
			this.logger.warn(
				{ errorType: error instanceof Error ? error.name : 'UnknownError' },
				'Unable to start Logto authentication',
			);
			throw new AuthenticationRequestError(
				'Logto is temporarily unavailable',
				503,
				'authentication_provider_unavailable',
			);
		}
		const now = currentTimestamp();
		const bindingToken = randomToken(32);
		const stored = await this.repository.authentication.createOidcTransaction({
			stateHash: hashToken(request.state),
			bindingHash: hashToken(bindingToken),
			codeVerifier: request.codeVerifier,
			nonce: request.nonce,
			returnTo: safeAuthenticationReturnPath(returnTo),
			logoutGeneration,
			expiresAt: new Date(Date.parse(now) + OIDC_TRANSACTION_TTL_MS).toISOString(),
		}, now, OIDC_TRANSACTION_LIMIT);
		if (!stored) {
			throw new AuthenticationRequestError(
				'Logto sign-in is temporarily busy',
				503,
				'authentication_busy',
			);
		}

		return { url: request.url, bindingToken };
	}

	/** Complete one valid Logto callback and issue the corresponding local session. */
	async completeLogto(
		currentUrl: string,
		state: string,
		bindingToken: string | undefined,
	): Promise<{ session: IssuedAuthenticationSession; returnTo: string }> {
		if (!this.provider) {
			throw new AuthenticationRequestError('Logto is not configured', 404, 'not_found');
		}

		if (!bindingToken || bindingToken.length > 512) {
			throw new AuthenticationRequestError(
				'Invalid or expired Logto sign-in state',
				401,
				'invalid_oidc_state',
			);
		}

		// Consume browser-bound state before admitting expensive provider work.
		const transaction = await this.repository.authentication.consumeOidcTransaction(
			hashToken(state),
			hashToken(bindingToken),
			currentTimestamp(),
		);
		if (!transaction) {
			throw new AuthenticationRequestError(
				'Invalid or expired Logto sign-in state',
				401,
				'invalid_oidc_state',
			);
		}

		if (this.activeOidcCompletions >= MAX_CONCURRENT_OIDC_COMPLETIONS) {
			throw new AuthenticationRequestError(
				'Logto sign-in completion is temporarily busy',
				503,
				'authentication_busy',
			);
		}

		// Reject saturation without creating an unbounded callback queue.
		this.activeOidcCompletions += 1;
		try {
			const identity = await this.provider.completeSignIn(
				currentUrl,
				`${this.config.publicUrl}/api/v1/auth/logto/callback`,
				state,
				transaction.codeVerifier,
				transaction.nonce,
			);
			const now = currentTimestamp();
			const issued = this.newSession({
				id: randomUUID(),
				provider: 'logto',
				displayName: identity.displayName,
				username: null,
			}, identity.providerSessionId, identity.providerLogoutHint);
			// Persist only if no provider logout crossed the original authorization start.
			const persisted = await this.repository.authentication
				.createLogtoSessionIfLogoutGenerationCurrent(
					identity,
					this.sessionInput(issued.record),
					transaction.logoutGeneration,
					now,
					MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY,
					MAX_AUTHENTICATION_SESSIONS,
				);
			if (!persisted) {
				throw new AuthenticationRequestError(
					'Provider logout crossed this sign-in; start again',
					409,
					'authentication_changed',
				);
			}

			issued.record.identity = persisted.identity;
			this.notifySessionRevocations(persisted.revokedTokenHashes);
			this.logger.info(
				{ identityId: persisted.identity.id, provider: 'logto' },
				'Administrator signed in',
			);
			return {
				session: issued,
				returnTo: transaction.returnTo,
			};
		}
		finally {
			this.activeOidcCompletions -= 1;
		}
	}

	/** Revoke one local session and return an optional provider end-session redirect. */
	async logout(record: AuthenticationSessionRecord): Promise<string | null> {
		await this.repository.authentication.deleteSession(record.tokenHash);
		this.notifySessionRevocations([record.tokenHash]);
		if (!this.provider || record.identity.provider !== 'logto') {
			return null;
		}

		try {
			return await this.provider.logoutUrl(
				record.providerLogoutHint,
				`${this.config.managementUrl}/login`,
			);
		}
		catch (error) {
			this.logger.warn(
				{ errorType: error instanceof Error ? error.name : 'UnknownError' },
				'Unable to complete provider logout',
			);
			return null;
		}
	}

	/** Validate a provider logout token and revoke matching local sessions. */
	async backchannelLogout(logoutToken: string): Promise<void> {
		if (!this.provider) {
			throw new AuthenticationRequestError('Logto is not configured', 404, 'not_found');
		}

		let identity: ExternalLogoutIdentity;
		try {
			identity = await this.validateBackchannelLogout(logoutToken);
		}
		catch (error) {
			if (error instanceof AuthenticationRequestError) {
				throw error;
			}

			this.logger.warn(
				{ errorType: error instanceof Error ? error.name : 'UnknownError' },
				'Rejected Logto back-channel logout token',
			);
			throw new AuthenticationRequestError(
				'Invalid provider logout token',
				401,
				'invalid_logout_token',
			);
		}
		const now = currentTimestamp();
		const applied = await this.repository.authentication.applyLogtoLogout({
			tokenHash: hashToken(`${identity.issuer}\0${identity.jti}`),
			tokenExpiresAt: new Date(Date.parse(now) + OIDC_LOGOUT_TOKEN_TTL_MS).toISOString(),
			issuer: identity.issuer,
			subject: identity.subject,
			sid: identity.sid,
			now,
			maximumTokens: OIDC_LOGOUT_TOKEN_LIMIT,
		});
		if (applied.status === 'busy') {
			throw new AuthenticationRequestError(
				'Provider logout processing is temporarily busy',
				503,
				'authentication_busy',
			);
		}

		this.notifySessionRevocations(applied.revokedTokenHashes);
	}

	/** Create a single-use local recovery code for the operator command. */
	async issueRecoveryToken(): Promise<string> {
		const token = randomToken(32);
		const createdAt = currentTimestamp();
		await this.repository.authentication.createRecoveryToken(
			hashToken(token),
			createdAt,
			new Date(Date.parse(createdAt) + RECOVERY_TOKEN_TTL_MS).toISOString(),
		);
		return token;
	}

	/** Remove expired sessions, redirect transactions, and recovery codes. */
	async prune(): Promise<void> {
		const revokedTokenHashes = await this.repository.authentication.prune(currentTimestamp());
		this.notifySessionRevocations(revokedTokenHashes);
	}

	/** Publish each distinct revoked session hash without exposing its bearer token. */
	private notifySessionRevocations(
		tokenHashes: readonly string[],
		reason: 'ended' | 'replaced' = 'ended',
	): void {
		const uniqueTokenHashes = [...new Set(tokenHashes)];
		if (uniqueTokenHashes.length === 0) {
			return;
		}

		for (const listener of this.sessionRevocationListeners) {
			listener(uniqueTokenHashes, reason);
		}
	}

	/** Select the persisted session fields shared by atomic identity/session repository operations. */
	private sessionInput(record: AuthenticationSessionRecord): {
		tokenHash: string;
		csrfToken: string;
		providerSessionId: string | null;
		providerLogoutHint: string | null;
		providerConfigurationHash: string | null;
		createdAt: string;
		lastSeenAt: string;
		expiresAt: string;
	} {
		return {
			tokenHash: record.tokenHash,
			csrfToken: record.csrfToken,
			providerSessionId: record.providerSessionId,
			providerLogoutHint: record.providerLogoutHint,
			providerConfigurationHash: record.providerConfigurationHash,
			createdAt: record.createdAt,
			lastSeenAt: record.lastSeenAt,
			expiresAt: record.expiresAt,
		};
	}

	/** Validate one provider logout within the process-wide public cryptographic-work bound. */
	private async validateBackchannelLogout(logoutToken: string): Promise<ExternalLogoutIdentity> {
		if (!this.provider) {
			throw new AuthenticationRequestError('Logto is not configured', 404, 'not_found');
		}
		if (this.activeLogoutVerifications >= MAX_CONCURRENT_LOGOUT_VERIFICATIONS) {
			throw new AuthenticationRequestError(
				'Provider logout verification is temporarily busy',
				503,
				'authentication_busy',
			);
		}

		this.activeLogoutVerifications += 1;
		try {
			return await this.provider.validateBackchannelLogout(logoutToken);
		}
		finally {
			this.activeLogoutVerifications -= 1;
		}
	}

	/** Issue a local session only if the password hash verified by the caller remains current. */
	private async issueLocalSessionIfCurrent(
		identity: AuthenticationIdentity,
		passwordHash: string,
	): Promise<IssuedAuthenticationSession | null> {
		const issued = this.newSession(identity, null, null);
		const created = await this.repository.authentication.createSessionIfLocalPasswordCurrent({
			tokenHash: issued.record.tokenHash,
			identityId: identity.id,
			csrfToken: issued.record.csrfToken,
			providerSessionId: null,
			providerLogoutHint: null,
			providerConfigurationHash: null,
			createdAt: issued.record.createdAt,
			lastSeenAt: issued.record.lastSeenAt,
			expiresAt: issued.record.expiresAt,
		}, passwordHash, MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY, MAX_AUTHENTICATION_SESSIONS);
		if (!created) {
			return null;
		}

		this.notifySessionRevocations(created.revokedTokenHashes);
		return issued;
	}

	/** Build one unpredictable session bearer and its safe record before conditional persistence. */
	private newSession(
		identity: AuthenticationIdentity,
		providerSessionId: string | null,
		providerLogoutHint: string | null,
	): IssuedAuthenticationSession {
		const token = randomToken(32);
		const tokenHash = hashToken(token);
		const now = currentTimestamp();
		const record: AuthenticationSessionRecord = {
			tokenHash,
			identity,
			csrfToken: randomToken(32),
			providerSessionId,
			providerLogoutHint,
			providerConfigurationHash: identity.provider === 'logto'
				? this.providerConfigurationHash
				: null,
			createdAt: now,
			lastSeenAt: now,
			expiresAt: new Date(
				Date.parse(now) + (identity.provider === 'logto'
					? OIDC_SESSION_TTL_MS
					: AUTHENTICATION_SESSION_TTL_MS),
			).toISOString(),
		};
		return { token, record };
	}

	/** Preserve validated username spelling while deriving its normalized comparison key. */
	private normalizedLocalCredentials(credentials: LocalCredentials): {
		username: string;
		usernameKey: string;
	} {
		const username = localAuthenticationUsernameSchema.parse(credentials.username);
		const comparisonUsername = localAuthenticationUsernameSchema.parse(
			username.normalize('NFKC'),
		);
		return { username, usernameKey: usernameKey(comparisonUsername) };
	}

	/** Reserve an attempt key before expensive work and reject exhausted windows. */
	private requireAttempt(
		key: string,
		limiter: AuthenticationRateLimiter = this.limiter,
	): void {
		if (!limiter.reserve(key)) {
			throw new AuthenticationRequestError(
				'Too many authentication attempts; try again later',
				429,
				'authentication_rate_limited',
			);
		}
	}

	/** Spend equivalent Argon2 work when no local username exists. */
	private async consumeDummyPasswordWork(password: string): Promise<false> {
		await this.passwordHash(password);
		return false;
	}

	/** Derive a password hash within the process-wide memory-hard operation bound. */
	private async passwordHash(password: string): Promise<string> {
		return this.passwordOperation(() => hashPassword(password));
	}

	/** Verify a password within the process-wide memory-hard operation bound. */
	private async passwordMatches(password: string, encoded: string): Promise<boolean> {
		return this.passwordOperation(() => verifyPassword(password, encoded));
	}

	/** Reject excess Argon2 work rather than allowing an unbounded native worker queue. */
	private async passwordOperation<T>(operation: () => Promise<T>): Promise<T> {
		if (this.activePasswordOperations >= MAX_CONCURRENT_PASSWORD_OPERATIONS) {
			throw new AuthenticationRequestError(
				'Authentication is temporarily busy',
				503,
				'authentication_busy',
			);
		}

		this.activePasswordOperations += 1;
		try {
			return await operation();
		}
		finally {
			this.activePasswordOperations -= 1;
		}
	}
}
