import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	AuthenticationProviderAdapter,
	ExternalLogoutIdentity,
	ExternalSignInRequest,
} from '@server/auth/provider.js';
import { hashPassword, verifyPassword } from '@server/auth/crypto.js';
import { AUTHENTICATION_MAX_ATTEMPTS } from '@server/auth/rate-limiter.js';
import {
	AUTHENTICATION_SESSION_TTL_MS,
	AuthenticationService,
	MAX_AUTHENTICATION_SESSIONS,
	MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY,
	MAX_CONCURRENT_OIDC_COMPLETIONS,
	MAX_CONCURRENT_LOGOUT_VERIFICATIONS,
	OIDC_SESSION_TTL_MS,
	OIDC_START_MAX_ATTEMPTS,
	OIDC_TRANSACTION_LIMIT,
} from '@server/auth/service.js';
import type { ExternalAuthenticationIdentity } from '@server/auth/contracts.js';
import { loadConfig } from '@server/config.js';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';

const cleanups: Array<() => Promise<void>> = [];

class FakeLogtoProvider implements AuthenticationProviderAdapter {
	readonly id = 'logto' as const;
	lastState = '';
	providerSessionId = 'provider-session';
	completeSignInCalls = 0;
	completionPromise: Promise<ExternalAuthenticationIdentity> | null = null;
	logout: ExternalLogoutIdentity = {
		issuer: 'https://tenant.logto.app/oidc',
		jti: 'logout-1',
		subject: 'subject-1',
		sid: 'provider-session',
	};
	private signInCount = 0;

	async createSignIn(): Promise<ExternalSignInRequest> {
		this.signInCount += 1;
		this.lastState = `provider-state-${this.signInCount}`;
		return {
			url: `https://tenant.logto.app/oidc/auth?state=${this.lastState}`,
			state: this.lastState,
			codeVerifier: 'verifier',
			nonce: 'nonce',
		};
	}

	async completeSignIn(): Promise<ExternalAuthenticationIdentity> {
		this.completeSignInCalls += 1;
		if (this.completionPromise) {
			return this.completionPromise;
		}

		return {
			issuer: 'https://tenant.logto.app/oidc',
			subject: 'subject-1',
			displayName: 'OIDC Admin',
			providerSessionId: this.providerSessionId,
			providerLogoutHint: 'encrypted-hint',
		};
	}

	async logoutUrl(): Promise<string> {
		return 'https://tenant.logto.app/oidc/session/end';
	}

	async validateBackchannelLogout(): Promise<ExternalLogoutIdentity> {
		return this.logout;
	}
}

async function fixture(provider: AuthenticationProviderAdapter | null = null) {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-auth-'));
	const config = loadConfig({
		dataDir: root,
		databasePath: path.join(root, 'test.sqlite'),
		migrationsDir: path.resolve('drizzle'),
		publicUrl: 'https://moirai.example.test',
		logto: provider ? {
			endpoint: 'https://tenant.logto.app',
			appId: 'app-id',
			appSecret: 'app-secret',
		} : null,
	});
	const database = createDatabase(config.databasePath, config.migrationsDir);
	const shell = Fastify({ logger: false });
	const repository = new Repository(database.db);
	const authentication = new AuthenticationService(
		repository,
		config,
		shell.log as FastifyBaseLogger,
		provider,
	);
	cleanups.push(async () => {
		database.close();
		await shell.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		authentication,
		repository,
		database,
		config,
		logger: shell.log as FastifyBaseLogger,
	};
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('administrator authentication service', () => {
	it('hashes and verifies local passwords with a salted Argon2id record', async () => {
		const first = await hashPassword('a sufficiently long password');
		const second = await hashPassword('a sufficiently long password');
		expect(first).toMatch(/^argon2id\$v=1\$/u);
		expect(second).not.toBe(first);
		expect(await verifyPassword('a sufficiently long password', first)).toBe(true);
		expect(await verifyPassword('the wrong long password', first)).toBe(false);
	});

	it('lets a first Logto identity initialize access and closes anonymous local setup', async () => {
		const provider = new FakeLogtoProvider();
		const { authentication } = await fixture(provider);
		const started = await authentication.beginLogto('/channels', '192.0.2.10');
		expect(started.url).toContain('tenant.logto.app');
		const completed = await authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			started.bindingToken,
		);
		expect(completed.returnTo).toBe('/channels');
		expect((await authentication.state(completed.session.record))).toMatchObject({
			status: 'authenticated',
			methods: { local: false, logto: true },
			identity: { provider: 'logto', displayName: 'OIDC Admin' },
		});

		await expect(authentication.setupLocal({
			username: 'local-admin',
			password: 'a sufficiently long password',
		}, '127.0.0.1')).rejects.toMatchObject({
			statusCode: 409,
			code: 'authentication_initialized',
		});

		const local = await authentication.saveLocalCredentials({
			username: 'Fallback Admin',
			password: 'another sufficiently long password',
			currentPassword: null,
		}, completed.session.record);
		expect(local.record.identity).toMatchObject({ provider: 'local', username: 'Fallback Admin' });
	});

	it('gives Logto sessions a non-sliding twenty-four-hour lifetime', async () => {
		vi.useFakeTimers();
		const now = Date.now();
		const provider = new FakeLogtoProvider();
		const { authentication } = await fixture(provider);
		const started = await authentication.beginLogto('/', '192.0.2.10');
		const completed = await authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			started.bindingToken,
		);

		expect(Date.parse(completed.session.record.expiresAt)).toBe(now + OIDC_SESSION_TTL_MS);
		expect(completed.session.record.providerConfigurationHash).toMatch(/^[a-f0-9]{64}$/u);

		vi.setSystemTime(now + OIDC_SESSION_TTL_MS - 1_000);
		const active = await authentication.resolveRequestSession(completed.session.token, true);
		expect(active.record).not.toBeNull();
		expect(active.refreshToken).toBeNull();

		vi.setSystemTime(now + OIDC_SESSION_TTL_MS);
		expect(await authentication.resolveSession(completed.session.token)).toBeNull();
	});

	it('revokes Logto sessions after disabling or changing the configured application', async () => {
		const provider = new FakeLogtoProvider();
		const { authentication, repository, config, logger } = await fixture(provider);
		const issue = async (remoteAddress: string) => {
			const started = await authentication.beginLogto('/', remoteAddress);
			return authentication.completeLogto(
				`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
				provider.lastState,
				started.bindingToken,
			);
		};

		const retained = await issue('192.0.2.10');
		const secretRotated = new AuthenticationService(repository, {
			...config,
			logto: { ...config.logto!, appSecret: 'rotated-secret' },
		}, logger, provider);
		await secretRotated.start();
		secretRotated.close();
		expect(await authentication.resolveSession(retained.session.token)).not.toBeNull();

		const applicationChanged = new AuthenticationService(repository, {
			...config,
			logto: { ...config.logto!, appId: 'replacement-app-id' },
		}, logger, provider);
		await applicationChanged.start();
		applicationChanged.close();
		expect(await authentication.resolveSession(retained.session.token)).toBeNull();

		const disabledCandidate = await issue('192.0.2.11');
		const disabled = new AuthenticationService(
			repository,
			{ ...config, logto: null },
			logger,
			null,
		);
		await disabled.start();
		disabled.close();
		expect(await authentication.resolveSession(disabledCandidate.session.token)).toBeNull();
	});

	it('bounds concurrent OIDC callback exchanges without queueing valid transactions', async () => {
		const provider = new FakeLogtoProvider();
		let releaseCompletion!: (identity: ExternalAuthenticationIdentity) => void;
		provider.completionPromise = new Promise((resolve) => {
			releaseCompletion = resolve;
		});
		const { authentication } = await fixture(provider);
		const pending: Array<Promise<unknown>> = [];

		for (let index = 0; index < MAX_CONCURRENT_OIDC_COMPLETIONS; index += 1) {
			const started = await authentication.beginLogto('/', '192.0.2.10');
			pending.push(authentication.completeLogto(
				`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
				provider.lastState,
				started.bindingToken,
			));
		}
		await vi.waitFor(() => {
			expect(provider.completeSignInCalls).toBe(MAX_CONCURRENT_OIDC_COMPLETIONS);
		});

		const overflow = await authentication.beginLogto('/', '192.0.2.10');
		await expect(authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			overflow.bindingToken,
		)).rejects.toMatchObject({ statusCode: 503, code: 'authentication_busy' });
		expect(provider.completeSignInCalls).toBe(MAX_CONCURRENT_OIDC_COMPLETIONS);

		releaseCompletion({
			issuer: 'https://tenant.logto.app/oidc',
			subject: 'subject-1',
			displayName: 'OIDC Admin',
			providerSessionId: 'provider-session',
			providerLogoutHint: 'encrypted-hint',
		});
		await Promise.all(pending);

		provider.completionPromise = Promise.reject(new Error('provider exchange failed'));
		const failed = await authentication.beginLogto('/', '192.0.2.11');
		await expect(authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			failed.bindingToken,
		)).rejects.toThrow('provider exchange failed');
		provider.completionPromise = null;

		const resumed = await authentication.beginLogto('/', '192.0.2.12');
		await expect(authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			resumed.bindingToken,
		)).resolves.toMatchObject({ session: { record: { identity: { provider: 'logto' } } } });
	});

	it('reports concurrent local fallback creation without revoking the losing OIDC session', async () => {
		const provider = new FakeLogtoProvider();
		const { authentication, repository } = await fixture(provider);
		const firstStart = await authentication.beginLogto('/', '192.0.2.10');
		const first = await authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			firstStart.bindingToken,
		);
		provider.providerSessionId = 'provider-session-2';
		const secondStart = await authentication.beginLogto('/', '192.0.2.11');
		const second = await authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			secondStart.bindingToken,
		);
		const createIdentity = repository.authentication.replaceLocalIdentityAndSession
			.bind(repository.authentication);
		const createIdentitySpy = vi.spyOn(
			repository.authentication,
			'replaceLocalIdentityAndSession',
		);
		let winningToken = '';
		createIdentitySpy.mockImplementationOnce(async (...args) => {
			createIdentitySpy.mockImplementation(createIdentity);
			const winner = await authentication.saveLocalCredentials({
				username: 'Fallback Admin',
				password: 'the winning fallback password',
				currentPassword: null,
			}, second.session.record);
			winningToken = winner.token;
			return createIdentity(...args);
		});

		await expect(authentication.saveLocalCredentials({
			username: 'Fallback Admin',
			password: 'the losing fallback password',
			currentPassword: null,
		}, first.session.record)).rejects.toMatchObject({
			statusCode: 409,
			code: 'authentication_changed',
		});
		expect(await authentication.resolveSession(first.session.token)).not.toBeNull();
		expect(await authentication.resolveSession(second.session.token)).toBeNull();
		expect(await authentication.resolveSession(winningToken)).not.toBeNull();
	});

	it('revokes only the provider session named by a logout token that also contains a subject', async () => {
		const provider = new FakeLogtoProvider();
		const { authentication } = await fixture(provider);
		const revoked = vi.fn();
		authentication.subscribeSessionRevocations(revoked);
		const firstStart = await authentication.beginLogto('/', '192.0.2.10');
		const first = await authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			firstStart.bindingToken,
		);
		provider.providerSessionId = 'provider-session-2';
		const secondStart = await authentication.beginLogto('/', '192.0.2.10');
		const second = await authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			secondStart.bindingToken,
		);

		await authentication.backchannelLogout('validated-by-fake-provider');
		expect(await authentication.resolveSession(first.session.token)).toBeNull();
		expect(await authentication.resolveSession(second.session.token)).not.toBeNull();
		expect(revoked).toHaveBeenCalledWith([first.session.record.tokenHash], 'ended');
	});

	it('revokes every subject session when a provider logout token omits sid', async () => {
		const provider = new FakeLogtoProvider();
		const { authentication } = await fixture(provider);
		const firstStart = await authentication.beginLogto('/', '192.0.2.10');
		const first = await authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			firstStart.bindingToken,
		);
		provider.providerSessionId = 'provider-session-2';
		const secondStart = await authentication.beginLogto('/', '192.0.2.10');
		const second = await authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			secondStart.bindingToken,
		);
		provider.logout = {
			issuer: 'https://tenant.logto.app/oidc',
			jti: 'logout-2',
			subject: 'subject-1',
			sid: null,
		};

		await authentication.backchannelLogout('validated-by-fake-provider');
		expect(await authentication.resolveSession(first.session.token)).toBeNull();
		expect(await authentication.resolveSession(second.session.token)).toBeNull();
	});

	it('does not create a provider session when logout crosses its authorization exchange', async () => {
		const provider = new FakeLogtoProvider();
		const { authentication } = await fixture(provider);
		const started = await authentication.beginLogto('/', '192.0.2.10');
		let releaseSignIn!: () => void;
		const signInGate = new Promise<void>((resolve) => {
			releaseSignIn = resolve;
		});
		const completeSignIn = vi.spyOn(provider, 'completeSignIn');
		completeSignIn.mockImplementationOnce(async () => {
			await signInGate;
			return {
				issuer: 'https://tenant.logto.app/oidc',
				subject: 'subject-1',
				displayName: 'OIDC Admin',
				providerSessionId: 'provider-session',
				providerLogoutHint: 'encrypted-hint',
			};
		});
		const completion = authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			started.bindingToken,
		);
		await vi.waitFor(() => expect(completeSignIn).toHaveBeenCalledOnce());

		await authentication.backchannelLogout('validated-by-fake-provider');
		releaseSignIn();

		await expect(completion).rejects.toMatchObject({
			statusCode: 409,
			code: 'authentication_changed',
		});
	});

	it('rejects an authorization begun before a completed provider logout', async () => {
		const provider = new FakeLogtoProvider();
		const { authentication } = await fixture(provider);
		const started = await authentication.beginLogto('/', '192.0.2.10');

		await authentication.backchannelLogout('validated-by-fake-provider');

		await expect(authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			started.bindingToken,
		)).rejects.toMatchObject({
			statusCode: 409,
			code: 'authentication_changed',
		});
	});

	it('treats a replayed subject logout as idempotent for a later provider session', async () => {
		const provider = new FakeLogtoProvider();
		provider.logout = {
			issuer: 'https://tenant.logto.app/oidc',
			jti: 'subject-logout',
			subject: 'subject-1',
			sid: null,
		};
		const { authentication } = await fixture(provider);
		const firstStart = await authentication.beginLogto('/', '192.0.2.10');
		const first = await authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			firstStart.bindingToken,
		);
		await authentication.backchannelLogout('validated-by-fake-provider');
		expect(await authentication.resolveSession(first.session.token)).toBeNull();

		provider.providerSessionId = 'provider-session-2';
		const secondStart = await authentication.beginLogto('/', '192.0.2.10');
		const second = await authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			secondStart.bindingToken,
		);
		await authentication.backchannelLogout('same-validated-token');

		expect(await authentication.resolveSession(second.session.token)).not.toBeNull();
	});

	it('bounds concurrent provider logout verification work', async () => {
		const provider = new FakeLogtoProvider();
		const { authentication } = await fixture(provider);
		let releaseVerification!: () => void;
		const verificationGate = new Promise<void>((resolve) => {
			releaseVerification = resolve;
		});
		const validate = vi.spyOn(provider, 'validateBackchannelLogout')
			.mockImplementation(async () => {
				await verificationGate;
				return provider.logout;
			});
		const accepted = Array.from(
			{ length: MAX_CONCURRENT_LOGOUT_VERIFICATIONS },
			() => authentication.backchannelLogout('validated-by-fake-provider'),
		);
		await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(
			MAX_CONCURRENT_LOGOUT_VERIFICATIONS,
		));

		await expect(authentication.backchannelLogout('excess-token')).rejects.toMatchObject({
			statusCode: 503,
			code: 'authentication_busy',
		});
		releaseVerification();
		await Promise.all(accepted);
	});

	it('rate limits OIDC starts per client before provider work can grow persistent state', async () => {
		const provider = new FakeLogtoProvider();
		const { authentication, database } = await fixture(provider);
		for (let index = 0; index < OIDC_START_MAX_ATTEMPTS; index += 1) {
			await authentication.beginLogto('/', '192.0.2.10');
		}

		await expect(authentication.beginLogto('/', '192.0.2.10')).rejects.toMatchObject({
			statusCode: 429,
			code: 'authentication_rate_limited',
		});
		expect(database.sqlite.prepare(
			'SELECT COUNT(*) AS count FROM authentication_oidc_transactions',
		).get()).toEqual({ count: OIDC_START_MAX_ATTEMPTS });
	});

	it('limits local login by client without locking the username for other addresses', async () => {
		const { authentication } = await fixture();
		await authentication.setupLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '192.0.2.1');

		for (let index = 0; index < AUTHENTICATION_MAX_ATTEMPTS; index += 1) {
			await expect(authentication.loginLocal({
				username: 'Local Admin',
				password: 'the wrong password is long enough',
			}, '192.0.2.10')).rejects.toMatchObject({
				statusCode: 401,
				code: 'invalid_credentials',
			});
		}

		await expect(authentication.loginLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '192.0.2.10')).rejects.toMatchObject({
			statusCode: 429,
			code: 'authentication_rate_limited',
		});
		await expect(authentication.loginLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '192.0.2.11')).resolves.toMatchObject({
			record: { identity: { username: 'Local Admin' } },
		});
	});

	it('evicts the oldest local session beyond the per-identity retention limit', async () => {
		const { authentication, database } = await fixture();
		const initial = await authentication.setupLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '127.0.0.1');
		const insert = database.sqlite.prepare(`
			INSERT INTO authentication_sessions (
				token_hash, identity_id, csrf_token, provider_session_id,
				provider_logout_hint, provider_configuration_hash, created_at,
				last_seen_at, expires_at
			) VALUES (?, ?, 'csrf', NULL, NULL, NULL, ?, ?, ?)
		`);
		const expiresAt = new Date(Date.now() + AUTHENTICATION_SESSION_TTL_MS).toISOString();
		database.sqlite.transaction(() => {
			for (let index = 0; index < MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY - 1; index += 1) {
				const timestamp = new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString();
				insert.run(
					`seed-${String(index).padStart(2, '0')}`,
					initial.record.identity.id,
					timestamp,
					timestamp,
					expiresAt,
				);
			}
		})();
		const revoked = vi.fn();
		authentication.subscribeSessionRevocations(revoked);

		await authentication.loginLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '192.0.2.40');

		expect(database.sqlite.prepare(
			'SELECT COUNT(*) AS count FROM authentication_sessions',
		).get()).toEqual({ count: MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY });
		expect(revoked).toHaveBeenCalledWith(['seed-00'], 'ended');
	});

	it('removes expired sessions before evicting active sessions at the identity limit', async () => {
		const { authentication, database } = await fixture();
		const initial = await authentication.setupLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '127.0.0.1');
		const insert = database.sqlite.prepare(`
			INSERT INTO authentication_sessions (
				token_hash, identity_id, csrf_token, provider_session_id,
				provider_logout_hint, provider_configuration_hash, created_at,
				last_seen_at, expires_at
			) VALUES (?, ?, 'csrf', NULL, NULL, NULL, ?, ?, ?)
		`);
		const activeExpiry = new Date(Date.now() + AUTHENTICATION_SESSION_TTL_MS).toISOString();
		insert.run(
			'expired-newer',
			initial.record.identity.id,
			'2099-01-01T00:00:00.000Z',
			'2099-01-01T00:00:00.000Z',
			'2000-01-01T00:00:00.000Z',
		);
		for (let index = 0; index < MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY - 2; index += 1) {
			const timestamp = new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString();
			insert.run(
				`active-${String(index).padStart(2, '0')}`,
				initial.record.identity.id,
				timestamp,
				timestamp,
				activeExpiry,
			);
		}
		const revoked = vi.fn();
		authentication.subscribeSessionRevocations(revoked);

		await authentication.loginLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '192.0.2.41');

		expect(database.sqlite.prepare(
			'SELECT COUNT(*) AS count FROM authentication_sessions',
		).get()).toEqual({ count: MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY });
		expect(database.sqlite.prepare(
			"SELECT token_hash AS tokenHash FROM authentication_sessions WHERE token_hash = 'active-00'",
		).get()).toEqual({ tokenHash: 'active-00' });
		expect(revoked).toHaveBeenCalledWith(['expired-newer'], 'ended');
	});

	it('evicts the oldest provider session beyond the installation retention limit', async () => {
		const provider = new FakeLogtoProvider();
		const { authentication, database } = await fixture(provider);
		const insertIdentity = database.sqlite.prepare(`
			INSERT INTO authentication_identities (
				id, provider, provider_issuer, provider_subject, display_name,
				username, username_key, password_hash, created_at, updated_at
			) VALUES (?, 'logto', ?, ?, ?, NULL, NULL, NULL, ?, ?)
		`);
		const insertSession = database.sqlite.prepare(`
			INSERT INTO authentication_sessions (
				token_hash, identity_id, csrf_token, provider_session_id,
				provider_logout_hint, provider_configuration_hash, created_at,
				last_seen_at, expires_at
			) VALUES (?, ?, 'csrf', ?, NULL, 'configuration', ?, ?, ?)
		`);
		const issuer = 'https://seed.logto.app/oidc';
		const expiresAt = new Date(Date.now() + OIDC_SESSION_TTL_MS).toISOString();
		database.sqlite.transaction(() => {
			for (let index = 0; index < MAX_AUTHENTICATION_SESSIONS; index += 1) {
				const identityIndex = Math.floor(index / MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY);
				const identityId = `identity-${identityIndex}`;
				const timestamp = new Date(Date.UTC(2020, 0, 1) + index * 1_000).toISOString();
				if (index % MAX_AUTHENTICATION_SESSIONS_PER_IDENTITY === 0) {
					insertIdentity.run(
						identityId,
						issuer,
						`subject-${identityIndex}`,
						`Admin ${identityIndex}`,
						timestamp,
						timestamp,
					);
				}
				insertSession.run(
					`global-${String(index).padStart(4, '0')}`,
					identityId,
					`sid-${index}`,
					timestamp,
					timestamp,
					expiresAt,
				);
			}
		})();
		const revoked = vi.fn();
		authentication.subscribeSessionRevocations(revoked);
		const started = await authentication.beginLogto('/', '192.0.2.50');

		await authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			started.bindingToken,
		);

		expect(database.sqlite.prepare(
			'SELECT COUNT(*) AS count FROM authentication_sessions',
		).get()).toEqual({ count: MAX_AUTHENTICATION_SESSIONS });
		expect(revoked).toHaveBeenCalledWith(['global-0000'], 'ended');
	});

	it('prunes expired OIDC state and refuses to exceed the global transaction cap', async () => {
		const provider = new FakeLogtoProvider();
		const { authentication, database } = await fixture(provider);
		database.sqlite.prepare(
			`INSERT INTO authentication_oidc_transactions
				(state_hash, binding_hash, code_verifier, nonce, return_to, expires_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
		).run('expired', 'binding', 'verifier', 'nonce', '/', '2000-01-01T00:00:00.000Z');
		for (let index = 0; index < OIDC_TRANSACTION_LIMIT; index += 1) {
			await authentication.beginLogto('/', `2001:db8::${index}`);
		}

		await expect(authentication.beginLogto('/', '2001:db8::overflow')).rejects.toMatchObject({
			statusCode: 503,
			code: 'authentication_busy',
		});
		expect(database.sqlite.prepare(
			'SELECT COUNT(*) AS count FROM authentication_oidc_transactions',
		).get()).toEqual({ count: OIDC_TRANSACTION_LIMIT });
	});

	it('uses a one-time recovery code to create local access without exposing a password', async () => {
		const { authentication } = await fixture();
		const token = await authentication.issueRecoveryToken();
		const recovered = await authentication.recoverLocal(token, {
			username: 'Recovery Admin',
			password: 'recovered long password',
		}, '127.0.0.1');
		expect((await authentication.state(recovered.record))).toMatchObject({
			status: 'authenticated',
			localUsername: 'Recovery Admin',
		});
		await expect(authentication.recoverLocal(token, {
			username: 'Recovery Admin',
			password: 'another recovered password',
		}, '127.0.0.1')).rejects.toMatchObject({ statusCode: 401 });
	});

	it('distinguishes the initiating replacement from other sessions during credential rotation', async () => {
		const { authentication } = await fixture();
		const initial = await authentication.setupLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '127.0.0.1');
		const other = await authentication.loginLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '192.0.2.20');
		const revoked = vi.fn();
		authentication.subscribeSessionRevocations(revoked);

		const rotated = await authentication.saveLocalCredentials({
			username: 'Local Admin',
			password: 'a different sufficiently long password',
			currentPassword: 'a sufficiently long password',
		}, initial.record);

		expect(revoked).toHaveBeenNthCalledWith(1, [other.record.tokenHash], 'ended');
		expect(revoked).toHaveBeenNthCalledWith(2, [initial.record.tokenHash], 'replaced');
		expect(await authentication.resolveSession(initial.token)).toBeNull();
		expect(await authentication.resolveSession(other.token)).toBeNull();
		expect(await authentication.resolveSession(rotated.token)).not.toBeNull();

		expect(await authentication.resolveRequestSession(initial.token, true)).toEqual({
			record: null,
			refreshToken: null,
		});
		expect(await authentication.resolveRequestSession(other.token, true)).toEqual({
			record: null,
			refreshToken: null,
		});
	});

	it('rejects a stale password verification that overlaps credential rotation', async () => {
		const { authentication, repository } = await fixture();
		const initial = await authentication.setupLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '127.0.0.1');
		const createSession = repository.authentication.createSessionIfLocalPasswordCurrent
			.bind(repository.authentication);
		const createSessionSpy = vi.spyOn(
			repository.authentication,
			'createSessionIfLocalPasswordCurrent',
		);
		let replacementToken = '';
		createSessionSpy.mockImplementationOnce(async (...args) => {
			createSessionSpy.mockImplementation(createSession);
			const replacement = await authentication.saveLocalCredentials({
				username: 'Local Admin',
				password: 'a replacement sufficiently long password',
				currentPassword: 'a sufficiently long password',
			}, initial.record);
			replacementToken = replacement.token;
			return createSession(...args);
		});

		await expect(authentication.loginLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '192.0.2.30')).rejects.toMatchObject({
			statusCode: 401,
			code: 'invalid_credentials',
		});
		expect(await authentication.resolveSession(initial.token)).toBeNull();
		expect(await authentication.resolveSession(replacementToken)).not.toBeNull();
	});

	it('allows only one credential change to commit after both verify the prior password', async () => {
		const { authentication, repository } = await fixture();
		const initial = await authentication.setupLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '127.0.0.1');
		const replaceIdentity = repository.authentication.replaceLocalIdentityAndSession
			.bind(repository.authentication);
		const replaceIdentitySpy = vi.spyOn(
			repository.authentication,
			'replaceLocalIdentityAndSession',
		);
		let winningToken = '';
		replaceIdentitySpy.mockImplementationOnce(async (...args) => {
			replaceIdentitySpy.mockImplementation(replaceIdentity);
			const winner = await authentication.saveLocalCredentials({
				username: 'Local Admin',
				password: 'the winning sufficiently long password',
				currentPassword: 'a sufficiently long password',
			}, initial.record);
			winningToken = winner.token;
			return replaceIdentity(...args);
		});

		await expect(authentication.saveLocalCredentials({
			username: 'Local Admin',
			password: 'the stale sufficiently long password',
			currentPassword: 'a sufficiently long password',
		}, initial.record)).rejects.toMatchObject({
			statusCode: 401,
			code: 'invalid_credentials',
		});
		expect(await authentication.resolveSession(winningToken)).not.toBeNull();
		expect((await authentication.loginLocal({
			username: 'Local Admin',
			password: 'the winning sufficiently long password',
		}, '192.0.2.31')).record.identity.username).toBe('Local Admin');
		await expect(authentication.loginLocal({
			username: 'Local Admin',
			password: 'the stale sufficiently long password',
		}, '192.0.2.32')).rejects.toMatchObject({ statusCode: 401 });
	});

	it('preserves prior credentials and sessions when atomic replacement persistence fails', async () => {
		const { authentication, repository } = await fixture();
		const initial = await authentication.setupLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '127.0.0.1');
		const revoked = vi.fn();
		authentication.subscribeSessionRevocations(revoked);
		vi.spyOn(repository.authentication, 'replaceLocalIdentityAndSession')
			.mockRejectedValueOnce(new Error('simulated storage failure'));

		await expect(authentication.saveLocalCredentials({
			username: 'Changed Admin',
			password: 'a replacement sufficiently long password',
			currentPassword: 'a sufficiently long password',
		}, initial.record)).rejects.toThrow('simulated storage failure');

		const local = await repository.authentication.localIdentity();
		expect(local?.username).toBe('Local Admin');
		expect(await verifyPassword('a sufficiently long password', local!.passwordHash)).toBe(true);
		expect(await authentication.resolveSession(initial.token)).not.toBeNull();
		expect(revoked).not.toHaveBeenCalled();
	});

	it('rate limits repeated current-password failures for credential replacement', async () => {
		const { authentication } = await fixture();
		const initial = await authentication.setupLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '127.0.0.1');
		for (let attempt = 0; attempt < AUTHENTICATION_MAX_ATTEMPTS; attempt += 1) {
			await expect(authentication.saveLocalCredentials({
				username: 'Changed Admin',
				password: 'a replacement sufficiently long password',
				currentPassword: `wrong current password ${attempt}`,
			}, initial.record)).rejects.toMatchObject({
				statusCode: 401,
				code: 'invalid_credentials',
			});
		}

		await expect(authentication.saveLocalCredentials({
			username: 'Changed Admin',
			password: 'a replacement sufficiently long password',
			currentPassword: 'a sufficiently long password',
		}, initial.record)).rejects.toMatchObject({
			statusCode: 429,
			code: 'authentication_rate_limited',
		});
	});

	it('does not replace credentials after the initiating session is revoked', async () => {
		const { authentication, repository } = await fixture();
		const initial = await authentication.setupLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '127.0.0.1');
		await authentication.logout(initial.record);

		await expect(authentication.saveLocalCredentials({
			username: 'Changed Admin',
			password: 'a replacement sufficiently long password',
			currentPassword: 'a sufficiently long password',
		}, initial.record)).rejects.toMatchObject({
			statusCode: 401,
			code: 'invalid_credentials',
		});

		const local = await repository.authentication.localIdentity();
		expect(local?.username).toBe('Local Admin');
		expect(await verifyPassword('a sufficiently long password', local!.passwordHash)).toBe(true);
	});

	it('retains the browser bearer when extending a sliding session', async () => {
		const { authentication } = await fixture();
		const initial = await authentication.setupLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '127.0.0.1');
		const future = Date.now() + 25 * 60 * 60 * 1_000;
		vi.useFakeTimers();
		vi.setSystemTime(future);

		const resolved = await authentication.resolveRequestSession(initial.token, true);

		expect(resolved.record).not.toBeNull();
		expect(resolved.refreshToken).toBe(initial.token);
		expect(Date.parse(resolved.record!.expiresAt)).toBe(future + AUTHENTICATION_SESSION_TTL_MS);
		expect(await authentication.resolveSession(initial.token)).not.toBeNull();

		const overlapping = await authentication.resolveRequestSession(initial.token, true);
		expect(overlapping.record?.tokenHash).toBe(resolved.record?.tokenHash);
		expect(overlapping.refreshToken).toBeNull();
	});

	it('invalidates a touched stable bearer during later credential rotation', async () => {
		const { authentication } = await fixture();
		const initial = await authentication.setupLocal({
			username: 'Local Admin',
			password: 'a sufficiently long password',
		}, '127.0.0.1');
		const future = Date.now() + 25 * 60 * 60 * 1_000;
		vi.useFakeTimers();
		vi.setSystemTime(future);
		const touched = await authentication.resolveRequestSession(initial.token, true);
		await authentication.saveLocalCredentials({
			username: 'Local Admin',
			password: 'a replacement sufficiently long password',
			currentPassword: 'a sufficiently long password',
		}, touched.record!);

		const overlapping = await authentication.resolveRequestSession(initial.token, true);

		expect(overlapping).toEqual({ record: null, refreshToken: null });
	});

	it('rejects an OIDC callback without the initiating browser binding', async () => {
		const provider = new FakeLogtoProvider();
		const { authentication, database } = await fixture(provider);
		const started = await authentication.beginLogto('/', '192.0.2.10');
		const stored = database.sqlite.prepare(
			'SELECT binding_hash AS bindingHash FROM authentication_oidc_transactions',
		).get() as { bindingHash: string };
		expect(stored.bindingHash).not.toBe(started.bindingToken);

		await expect(authentication.completeLogto(
			`https://moirai.example.test/api/v1/auth/logto/callback?state=${provider.lastState}&code=code`,
			provider.lastState,
			'attacker-controlled-binding',
		)).rejects.toMatchObject({ statusCode: 401, code: 'invalid_oidc_state' });
	});

	it('preserves authored username spelling while canonicalizing comparison', async () => {
		const { authentication } = await fixture();
		const authored = 'Ａｄｍｉｎ';
		const issued = await authentication.setupLocal({
			username: authored,
			password: 'a sufficiently long password',
		}, '127.0.0.1');

		expect(issued.record.identity.username).toBe(authored);
		expect((await authentication.loginLocal({
			username: 'Admin',
			password: 'a sufficiently long password',
		}, '192.0.2.40')).record.identity.username).toBe(authored);
	});
});
