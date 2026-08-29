import { randomUUID } from 'node:crypto';
import { and, count, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { AuthenticationIdentity } from '@moirai/shared';
import type {
	AuthenticationSessionRecord,
	ExternalAuthenticationIdentity,
	LocalAuthenticationIdentity,
	OidcTransactionRecord,
} from '../auth/contracts.js';
import type { MoiraiDatabase } from '../db/index.js';
import {
	authenticationIdentities,
	authenticationInitialization,
	authenticationOidcLogoutGeneration,
	authenticationOidcLogoutTokens,
	authenticationOidcTransactions,
	authenticationRecoveryTokens,
	authenticationSessions,
} from '../db/schema.js';

/** Input used to persist the singleton local administrator identity. */
interface LocalIdentityInput {
	username: string;
	usernameKey: string;
	passwordHash: string;
	displayName: string;
}

/** Input used to persist a revocable administrator browser session. */
interface SessionInput {
	tokenHash: string;
	identityId: string;
	csrfToken: string;
	providerSessionId: string | null;
	providerLogoutHint: string | null;
	providerConfigurationHash: string | null;
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
}

/** Session fields prepared before a transaction resolves the owning identity identifier. */
type PendingSessionInput = Omit<SessionInput, 'identityId'>;

/** Transaction handle used by atomic authentication state transitions. */
type AuthenticationTransaction = Parameters<Parameters<MoiraiDatabase['transaction']>[0]>[0];

/** Convert one selected identity row into its safe public representation. */
function publicIdentity(row: typeof authenticationIdentities.$inferSelect): AuthenticationIdentity {
	return {
		id: row.id,
		provider: row.provider,
		displayName: row.displayName,
		username: row.username,
	};
}

/** Delete oldest sessions beyond the per-identity and installation-wide retention limits. */
function pruneSessionOverflow(
	transaction: AuthenticationTransaction,
	identityId: string,
	newTokenHash: string,
	now: string,
	maximumPerIdentity: number,
	maximumTotal: number,
): string[] {
	const expired = transaction.all<{ tokenHash: string }>(sql`
		DELETE FROM ${authenticationSessions}
		WHERE ${authenticationSessions.expiresAt} <= ${now}
		RETURNING ${authenticationSessions.tokenHash} AS "tokenHash"
	`);
	const identityOverflow = transaction.all<{ tokenHash: string }>(sql`
		DELETE FROM ${authenticationSessions}
		WHERE ${authenticationSessions.tokenHash} IN (
			SELECT ${authenticationSessions.tokenHash}
			FROM ${authenticationSessions}
			WHERE ${authenticationSessions.identityId} = ${identityId}
				AND ${authenticationSessions.tokenHash} <> ${newTokenHash}
			ORDER BY ${authenticationSessions.createdAt} DESC,
				${authenticationSessions.tokenHash} DESC
			LIMIT -1 OFFSET ${maximumPerIdentity - 1}
		)
		RETURNING ${authenticationSessions.tokenHash} AS "tokenHash"
	`);
	const globalOverflow = transaction.all<{ tokenHash: string }>(sql`
		DELETE FROM ${authenticationSessions}
		WHERE ${authenticationSessions.tokenHash} IN (
			SELECT ${authenticationSessions.tokenHash}
			FROM ${authenticationSessions}
			WHERE ${authenticationSessions.tokenHash} <> ${newTokenHash}
			ORDER BY ${authenticationSessions.createdAt} DESC,
				${authenticationSessions.tokenHash} DESC
			LIMIT -1 OFFSET ${maximumTotal - 1}
		)
		RETURNING ${authenticationSessions.tokenHash} AS "tokenHash"
	`);
	return [...new Set(
		[...expired, ...identityOverflow, ...globalOverflow].map((row) => row.tokenHash),
	)];
}

/**
 * Own authentication identity, session, OIDC transaction, and recovery persistence. Operations
 * that close first-run registration or consume one-time state remain atomic at this boundary.
 */
export class AuthenticationRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** Return whether either a local or OIDC identity initialized this installation. */
	async initialized(): Promise<boolean> {
		const [row] = await this.db.select({ id: authenticationInitialization.id })
			.from(authenticationInitialization)
			.limit(1);
		return Boolean(row);
	}

	/** Return the singleton local identity with its password hash. */
	async localIdentity(): Promise<LocalAuthenticationIdentity | null> {
		const [row] = await this.db.select().from(authenticationIdentities)
			.where(eq(authenticationIdentities.provider, 'local'))
			.limit(1);
		if (!row?.username || !row.passwordHash) {
			return null;
		}

		return {
			...publicIdentity(row),
			provider: 'local',
			username: row.username,
			passwordHash: row.passwordHash,
		};
	}

	/** Atomically create the first local identity only while the installation is uninitialized. */
	async claimInitialLocalIdentity(
		input: LocalIdentityInput,
		now: string,
	): Promise<AuthenticationIdentity | null> {
		return this.db.transaction((transaction) => {
			const claimed = transaction.insert(authenticationInitialization)
				.values({ id: 1, method: 'local', initializedAt: now })
				.onConflictDoNothing()
				.run();
			if (claimed.changes === 0) {
				return null;
			}

			const id = randomUUID();
			const [row] = transaction.insert(authenticationIdentities).values({
				id,
				provider: 'local',
				providerIssuer: null,
				providerSubject: null,
				...input,
				createdAt: now,
				updatedAt: now,
			}).returning().all();
			return row ? publicIdentity(row) : null;
		});
	}

	/**
	 * Create or replace local credentials, revoke affected sessions, and persist the initiating
	 * browser's replacement session as one atomic state transition.
	 */
	async replaceLocalIdentityAndSession(
		identityId: string,
		expectedPasswordHash: string | null | undefined,
		input: LocalIdentityInput,
		currentTokenHash: string | null,
		session: PendingSessionInput,
		now: string,
		maximumPerIdentity: number,
		maximumTotal: number,
	): Promise<{ identity: AuthenticationIdentity; revokedTokenHashes: string[] } | null> {
		return this.db.transaction((transaction) => {
			if (currentTokenHash) {
				const [currentSession] = transaction.select({
					tokenHash: authenticationSessions.tokenHash,
				}).from(authenticationSessions).where(
					eq(authenticationSessions.tokenHash, currentTokenHash),
				).limit(1).all();
				if (!currentSession) {
					return null;
				}
			}

			let row: typeof authenticationIdentities.$inferSelect | undefined;
			if (expectedPasswordHash === undefined) {
				transaction.insert(authenticationInitialization)
					.values({ id: 1, method: 'local', initializedAt: now })
					.onConflictDoNothing()
					.run();
				[row] = transaction.insert(authenticationIdentities).values({
					id: identityId,
					provider: 'local',
					providerIssuer: null,
					providerSubject: null,
					...input,
					createdAt: now,
					updatedAt: now,
				}).onConflictDoNothing().returning().all();
			}
			else {
				const condition = expectedPasswordHash === null
					? eq(authenticationIdentities.id, identityId)
					: and(
						eq(authenticationIdentities.id, identityId),
						eq(authenticationIdentities.passwordHash, expectedPasswordHash),
					);
				[row] = transaction.update(authenticationIdentities).set({
					...input,
					updatedAt: now,
				}).where(condition).returning().all();
			}
			if (!row) {
				return null;
			}

			const revokedTokenHashes = transaction.select({
				tokenHash: authenticationSessions.tokenHash,
			}).from(authenticationSessions)
				.where(eq(authenticationSessions.identityId, identityId))
				.all()
				.map((existingSession) => existingSession.tokenHash);
			if (currentTokenHash) {
				revokedTokenHashes.push(currentTokenHash);
			}

			transaction.delete(authenticationSessions)
				.where(eq(authenticationSessions.identityId, identityId))
				.run();
			if (currentTokenHash) {
				transaction.delete(authenticationSessions)
					.where(eq(authenticationSessions.tokenHash, currentTokenHash))
					.run();
			}
			transaction.insert(authenticationSessions).values({
				...session,
				identityId,
			}).run();
			revokedTokenHashes.push(...pruneSessionOverflow(
				transaction,
				identityId,
				session.tokenHash,
				now,
				maximumPerIdentity,
				maximumTotal,
			));
			return {
				identity: publicIdentity(row),
				revokedTokenHashes: [...new Set(revokedTokenHashes)],
			};
		});
	}

	/** Return the durable provider-logout generation observed before an authorization exchange. */
	async oidcLogoutGeneration(): Promise<number> {
		const [row] = await this.db.select({
			generation: authenticationOidcLogoutGeneration.generation,
		}).from(authenticationOidcLogoutGeneration).where(
			eq(authenticationOidcLogoutGeneration.id, 1),
		).limit(1);
		return row?.generation ?? 0;
	}

	/**
	 * Upsert a provider identity and create its session only if no logout crossed the authorization
	 * exchange that produced it.
	 */
	async createLogtoSessionIfLogoutGenerationCurrent(
		input: ExternalAuthenticationIdentity,
		session: PendingSessionInput,
		expectedGeneration: number,
		now: string,
		maximumPerIdentity: number,
		maximumTotal: number,
	): Promise<{ identity: AuthenticationIdentity; revokedTokenHashes: string[] } | null> {
		return this.db.transaction((transaction) => {
			const [generationRow] = transaction.select({
				generation: authenticationOidcLogoutGeneration.generation,
			}).from(authenticationOidcLogoutGeneration).where(
				eq(authenticationOidcLogoutGeneration.id, 1),
			).limit(1).all();
			if ((generationRow?.generation ?? 0) !== expectedGeneration) {
				return null;
			}

			transaction.insert(authenticationInitialization)
				.values({ id: 1, method: 'logto', initializedAt: now })
				.onConflictDoNothing()
				.run();
			const [existing] = transaction.select().from(authenticationIdentities).where(and(
				eq(authenticationIdentities.provider, 'logto'),
				eq(authenticationIdentities.providerIssuer, input.issuer),
				eq(authenticationIdentities.providerSubject, input.subject),
			)).limit(1).all();
			let row: typeof authenticationIdentities.$inferSelect;
			if (existing) {
				const [updated] = transaction.update(authenticationIdentities)
					.set({ displayName: input.displayName, updatedAt: now })
					.where(eq(authenticationIdentities.id, existing.id))
					.returning()
					.all();
				row = updated ?? existing;
			}
			else {
				const [created] = transaction.insert(authenticationIdentities).values({
					id: randomUUID(),
					provider: 'logto',
					providerIssuer: input.issuer,
					providerSubject: input.subject,
					displayName: input.displayName,
					username: null,
					usernameKey: null,
					passwordHash: null,
					createdAt: now,
					updatedAt: now,
				}).returning().all();
				if (!created) {
					throw new Error('Logto identity insert did not return a row');
				}
				row = created;
			}

			transaction.insert(authenticationSessions).values({
				...session,
				identityId: row.id,
			}).run();
			return {
				identity: publicIdentity(row),
				revokedTokenHashes: pruneSessionOverflow(
					transaction,
					row.id,
					session.tokenHash,
					now,
					maximumPerIdentity,
					maximumTotal,
				),
			};
		});
	}

	/** Insert a local session only while the password version verified by its caller remains current. */
	async createSessionIfLocalPasswordCurrent(
		input: SessionInput,
		passwordHash: string,
		maximumPerIdentity: number,
		maximumTotal: number,
	): Promise<{ revokedTokenHashes: string[] } | null> {
		return this.db.transaction((transaction) => {
			const [identity] = transaction.select({ id: authenticationIdentities.id })
				.from(authenticationIdentities)
				.where(and(
					eq(authenticationIdentities.id, input.identityId),
					eq(authenticationIdentities.provider, 'local'),
					eq(authenticationIdentities.passwordHash, passwordHash),
				))
				.limit(1)
				.all();
			if (!identity) {
				return null;
			}

			transaction.insert(authenticationSessions).values(input).run();
			return {
				revokedTokenHashes: pruneSessionOverflow(
					transaction,
					input.identityId,
					input.tokenHash,
					input.createdAt,
					maximumPerIdentity,
					maximumTotal,
				),
			};
		});
	}

	/** Resolve one unexpired browser session and its safe identity. */
	async session(tokenHash: string, now: string): Promise<AuthenticationSessionRecord | null> {
		const [row] = await this.db.select({
			session: authenticationSessions,
			identity: authenticationIdentities,
		}).from(authenticationSessions)
			.innerJoin(
				authenticationIdentities,
				eq(authenticationSessions.identityId, authenticationIdentities.id),
			)
			.where(and(
				eq(authenticationSessions.tokenHash, tokenHash),
				gt(authenticationSessions.expiresAt, now),
			))
			.limit(1);
		if (!row) {
			return null;
		}

		return {
			...row.session,
			identity: publicIdentity(row.identity),
		};
	}

	/** Extend one active session's inactivity deadline without changing its bearer. */
	async touchSession(
		tokenHash: string,
		lastSeenAt: string,
		expiresAt: string,
	): Promise<boolean> {
		const rows = await this.db.update(authenticationSessions)
			.set({ lastSeenAt, expiresAt })
			.where(eq(authenticationSessions.tokenHash, tokenHash))
			.returning({ tokenHash: authenticationSessions.tokenHash });
		return rows.length === 1;
	}

	/** Revoke one browser session by its token hash. */
	async deleteSession(tokenHash: string): Promise<void> {
		await this.db.delete(authenticationSessions)
			.where(eq(authenticationSessions.tokenHash, tokenHash));
	}

	/**
	 * Revoke provider sessions created for a disabled or different OIDC application configuration.
	 */
	async revokeLogtoSessionsForConfiguration(
		configurationHash: string | null,
	): Promise<string[]> {
		return this.db.transaction((transaction) => {
			const identityIds = transaction.select({ id: authenticationIdentities.id })
				.from(authenticationIdentities)
				.where(eq(authenticationIdentities.provider, 'logto'));
			const providerOwned = inArray(authenticationSessions.identityId, identityIds);
			const condition = configurationHash
				? and(
					providerOwned,
					or(
						isNull(authenticationSessions.providerConfigurationHash),
						ne(authenticationSessions.providerConfigurationHash, configurationHash),
					),
				)
				: providerOwned;
			const tokenHashes = transaction.select({ tokenHash: authenticationSessions.tokenHash })
				.from(authenticationSessions)
				.where(condition)
				.all()
				.map((row) => row.tokenHash);
			transaction.delete(authenticationSessions).where(condition).run();
			return tokenHashes;
		});
	}

	/**
	 * Deduplicate one validated provider logout, advance its ordering boundary, and revoke matching
	 * sessions in the same transaction.
	 */
	async applyLogtoLogout(input: {
		tokenHash: string;
		tokenExpiresAt: string;
		issuer: string;
		subject: string | null;
		sid: string | null;
		now: string;
		maximumTokens: number;
	}): Promise<{ status: 'applied' | 'duplicate' | 'busy'; revokedTokenHashes: string[] }> {
		return this.db.transaction((transaction) => {
			transaction.delete(authenticationOidcLogoutTokens)
				.where(lte(authenticationOidcLogoutTokens.expiresAt, input.now))
				.run();
			const [existingToken] = transaction.select({
				tokenHash: authenticationOidcLogoutTokens.tokenHash,
			}).from(authenticationOidcLogoutTokens).where(
				eq(authenticationOidcLogoutTokens.tokenHash, input.tokenHash),
			).limit(1).all();
			if (existingToken) {
				return { status: 'duplicate', revokedTokenHashes: [] };
			}

			const [retained] = transaction.select({ value: count() })
				.from(authenticationOidcLogoutTokens)
				.all();
			if ((retained?.value ?? 0) >= input.maximumTokens) {
				return { status: 'busy', revokedTokenHashes: [] };
			}

			transaction.insert(authenticationOidcLogoutTokens).values({
				tokenHash: input.tokenHash,
				expiresAt: input.tokenExpiresAt,
			}).run();
			transaction.insert(authenticationOidcLogoutGeneration).values({
				id: 1,
				generation: 1,
			}).onConflictDoUpdate({
				target: authenticationOidcLogoutGeneration.id,
				set: { generation: sql`${authenticationOidcLogoutGeneration.generation} + 1` },
			}).run();

			const identityIds = transaction.select({ id: authenticationIdentities.id })
				.from(authenticationIdentities)
				.where(and(
					eq(authenticationIdentities.provider, 'logto'),
					eq(authenticationIdentities.providerIssuer, input.issuer),
					...(input.subject
						? [eq(authenticationIdentities.providerSubject, input.subject)]
						: []),
				))
				.all()
				.map((row) => row.id);
			if (identityIds.length === 0) {
				return { status: 'applied', revokedTokenHashes: [] };
			}

			const condition = input.sid
				? and(
					eq(authenticationSessions.providerSessionId, input.sid),
					inArray(authenticationSessions.identityId, identityIds),
				)
				: inArray(authenticationSessions.identityId, identityIds);
			const revokedTokenHashes = transaction.select({
				tokenHash: authenticationSessions.tokenHash,
			}).from(authenticationSessions)
				.where(condition)
				.all()
				.map((row) => row.tokenHash);
			transaction.delete(authenticationSessions).where(condition).run();
			return { status: 'applied', revokedTokenHashes };
		});
	}

	/** Prune expired OIDC state and atomically persist one transaction beneath the global cap. */
	async createOidcTransaction(
		input: OidcTransactionRecord,
		now: string,
		maximumOutstanding: number,
	): Promise<boolean> {
		return this.db.transaction((transaction) => {
			transaction.delete(authenticationOidcTransactions)
				.where(lte(authenticationOidcTransactions.expiresAt, now))
				.run();
			const [outstanding] = transaction.select({ value: count() })
				.from(authenticationOidcTransactions)
				.all();
			if ((outstanding?.value ?? 0) >= maximumOutstanding) {
				return false;
			}

			transaction.insert(authenticationOidcTransactions).values(input).run();
			return true;
		});
	}

	/** Delete and return one valid browser-bound OIDC transaction so state cannot be replayed. */
	async consumeOidcTransaction(
		stateHash: string,
		bindingHash: string,
		now: string,
	): Promise<OidcTransactionRecord | null> {
		return this.db.transaction((transaction) => {
			const [row] = transaction.select().from(authenticationOidcTransactions)
				.where(and(
					eq(authenticationOidcTransactions.stateHash, stateHash),
					eq(authenticationOidcTransactions.bindingHash, bindingHash),
					gt(authenticationOidcTransactions.expiresAt, now),
				))
				.limit(1)
				.all();
			transaction.delete(authenticationOidcTransactions)
				.where(eq(authenticationOidcTransactions.stateHash, stateHash))
				.run();
			return row ?? null;
		});
	}

	/** Replace prior recovery state with one hashed, expiring operator code. */
	async createRecoveryToken(tokenHash: string, createdAt: string, expiresAt: string): Promise<void> {
		this.db.transaction((transaction) => {
			transaction.delete(authenticationRecoveryTokens).run();
			transaction.insert(authenticationRecoveryTokens)
				.values({ tokenHash, createdAt, expiresAt })
				.run();
		});
	}

	/** Return whether an operator recovery token is currently valid without consuming it. */
	async recoveryTokenActive(tokenHash: string, now: string): Promise<boolean> {
		const [row] = await this.db.select({ tokenHash: authenticationRecoveryTokens.tokenHash })
			.from(authenticationRecoveryTokens)
			.where(and(
				eq(authenticationRecoveryTokens.tokenHash, tokenHash),
				gt(authenticationRecoveryTokens.expiresAt, now),
			))
			.limit(1);
		return Boolean(row);
	}

	/** Consume a valid recovery code once and report whether it existed. */
	async consumeRecoveryToken(tokenHash: string, now: string): Promise<boolean> {
		return this.db.transaction((transaction) => {
			const [row] = transaction.select({ tokenHash: authenticationRecoveryTokens.tokenHash })
				.from(authenticationRecoveryTokens)
				.where(and(
					eq(authenticationRecoveryTokens.tokenHash, tokenHash),
					gt(authenticationRecoveryTokens.expiresAt, now),
				))
				.limit(1)
				.all();
			transaction.delete(authenticationRecoveryTokens)
				.where(eq(authenticationRecoveryTokens.tokenHash, tokenHash))
				.run();
			return Boolean(row);
		});
	}

	/** Delete expired authentication state and return session hashes invalidated by the cleanup. */
	async prune(now: string): Promise<string[]> {
		return this.db.transaction((transaction) => {
			const tokenHashes = transaction.select({ tokenHash: authenticationSessions.tokenHash })
				.from(authenticationSessions)
				.where(lt(authenticationSessions.expiresAt, now))
				.all()
				.map((row) => row.tokenHash);
			transaction.delete(authenticationSessions)
				.where(lt(authenticationSessions.expiresAt, now))
				.run();
			transaction.delete(authenticationOidcTransactions)
				.where(lt(authenticationOidcTransactions.expiresAt, now))
				.run();
			transaction.delete(authenticationOidcLogoutTokens)
				.where(lt(authenticationOidcLogoutTokens.expiresAt, now))
				.run();
			transaction.delete(authenticationRecoveryTokens)
				.where(lt(authenticationRecoveryTokens.expiresAt, now))
				.run();
			return tokenHashes;
		});
	}
}
