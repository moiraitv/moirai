import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
	canonicalIdentityKey,
	MEDIA_SERVER_PLAYBACK_REPORTING_PROVIDERS,
	type MediaServer,
	type MediaServerCreate,
	type MediaServerPathReplacement,
	type MediaServerUpdate,
} from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { libraries, mediaItems, mediaServers } from '../db/schema.js';
import type { MediaServerInspection } from '../media-servers/items.js';
import { canRetainMediaServerCredential } from '../media-servers/credentials.js';
import { currentTimestamp } from '../time.js';

/** Saved connection including the access token. Callers must not return this to the browser. */
export interface MediaServerConnectionRecord {
	id: string;
	provider: MediaServer['provider'];
	name: string;
	baseUrl: string;
	serverKey: string;
	serverName: string;
	clientIdentifier: string;
	accessToken: string;
	allowInsecureTls: boolean;
	playbackReportingEnabled: boolean;
	pathReplacements: MediaServerPathReplacement[];
}

/** Expected failure while saving or removing a media server. */
export class MediaServerPersistenceError extends Error {
	constructor(message: string, public readonly statusCode: 400 | 409 = 409) {
		super(message);
		this.name = 'MediaServerPersistenceError';
	}
}

/** Show the ends of a saved token only when enough characters remain hidden. */
function credentialPlaceholder(accessToken: string): string | null {
	if (!accessToken) {
		return null;
	}

	if (accessToken.length < 14) {
		return '••••••';
	}

	return `${accessToken.slice(0, 5)}...${accessToken.slice(-4)}`;
}

/** Hide credentials in legacy addresses while keeping their editable server path visible. */
function publicAddress(value: string): string {
	try {
		const address = new URL(value);
		address.username = '';
		address.password = '';
		address.search = '';
		address.hash = '';
		return address.href.replace(/\/$/, '');
	}
	catch {
		return '';
	}
}

/** Compare ordered path mappings without treating key order inside an entry as significant. */
function sameReplacements(
	left: MediaServerPathReplacement[],
	right: MediaServerPathReplacement[],
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Persist Plex, Jellyfin, and Emby connections separately from the libraries that use them.
 * API projections omit the access token. Deleting a server is refused while a library's
 * accepted source or a pending source change still points at it.
 */
export class MediaServerRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** List saved servers without their access tokens. */
	async listMediaServers(): Promise<MediaServer[]> {
		const rows = await this.db.select().from(mediaServers);
		return rows.map((row) => this.publicServer(row));
	}

	/** Read one saved server without its access token. */
	async getMediaServer(id: string): Promise<MediaServer | null> {
		const [row] = await this.db.select().from(mediaServers).where(eq(mediaServers.id, id));
		return row ? this.publicServer(row) : null;
	}

	/** Read the connection a scanner or stream proxy needs, including the access token. */
	async getMediaServerConnection(id: string): Promise<MediaServerConnectionRecord | null> {
		const [row] = await this.db.select().from(mediaServers).where(eq(mediaServers.id, id));
		if (!row) {
			return null;
		}

		return {
			id: row.id,
			provider: row.provider,
			name: row.name,
			baseUrl: row.baseUrl,
			serverKey: row.serverKey,
			serverName: row.serverName,
			clientIdentifier: row.clientIdentifier,
			accessToken: row.accessToken,
			allowInsecureTls: row.allowInsecureTls,
			playbackReportingEnabled: row.playbackReportingEnabled,
			pathReplacements: row.pathReplacements,
		};
	}

	/** Read opted-in supported connections in one batch for active channel reporting. */
	async playbackReportingConnections(): Promise<MediaServerConnectionRecord[]> {
		const rows = await this.db.select().from(mediaServers).where(
			and(inArray(mediaServers.provider, [...MEDIA_SERVER_PLAYBACK_REPORTING_PROVIDERS]), eq(mediaServers.playbackReportingEnabled, true)),
		);
		return rows;
	}

	/** Resolve Plex rating keys in one background-only query, since stream references hold part ids. */
	async plexPlaybackItems(ids: string[]): Promise<Array<{ id: string; serverId: string; ratingKey: string; durationMilliseconds: number | null }>> {
		if (ids.length === 0) {
			return [];
		}

		const rows = await this.db.select({
			id: mediaItems.id,
			ratingKey: mediaItems.stableKey,
			durationMilliseconds: mediaItems.durationMilliseconds,
			sourceConfig: libraries.sourceConfig,
		}).from(mediaItems).innerJoin(libraries, eq(libraries.id, mediaItems.libraryId))
			.where(and(inArray(mediaItems.id, ids), eq(libraries.sourceType, 'plex')));
		return rows.flatMap(({ sourceConfig, ...item }) => {
			const serverId = 'mediaServerId' in sourceConfig ? sourceConfig.mediaServerId : null;
			return typeof serverId === 'string' ? [{ ...item, serverId }] : [];
		});
	}

	/** Store a server after the caller has confirmed its identity. */
	async createMediaServer(
		input: MediaServerCreate,
		inspection: MediaServerInspection,
	): Promise<MediaServer> {
		assertReportingProvider(input.provider, input.playbackReportingEnabled);
		const nameKey = canonicalIdentityKey(input.name);
		await this.assertNameAvailable(nameKey, null);
		await this.assertServerAvailable(input.provider, inspection.serverKey, null);
		const timestamp = currentTimestamp();
		const id = randomUUID();
		try {
			await this.db.insert(mediaServers).values({
				id,
				provider: input.provider,
				name: input.name,
				nameKey,
				baseUrl: input.baseUrl,
				serverKey: inspection.serverKey,
				serverName: inspection.serverName,
				clientIdentifier: input.clientIdentifier?.trim() || randomUUID(),
				accessToken: input.accessToken,
				allowInsecureTls: input.allowInsecureTls,
				playbackReportingEnabled: input.playbackReportingEnabled,
				pathReplacements: input.pathReplacements,
				createdAt: timestamp,
				updatedAt: timestamp,
			});
		}
		catch (error) {
			this.rethrowUnique(error);
		}

		return (await this.getMediaServer(id))!;
	}

	/**
	 * Apply an edit after a fresh connection check.
	 * A blank token keeps the stored credential only while its destination and TLS policy stay safe.
	 * The writer rechecks credential reuse after probing and rejects a different server identity.
	 * Changed path mappings return the libraries that should be scanned again.
	 */
	async updateMediaServer(
		id: string,
		input: MediaServerUpdate,
		inspection: MediaServerInspection,
	): Promise<{ server: MediaServer; rescanLibraryIds: string[] } | null> {
		const existing = await this.getMediaServerConnection(id);
		if (!existing) {
			return null;
		}

		if (input.provider && input.provider !== existing.provider) {
			throw new MediaServerPersistenceError('A saved server cannot change its provider', 400);
		}

		if (inspection.serverKey !== existing.serverKey) {
			throw new MediaServerPersistenceError(
				'This address belongs to a different server. Add it as a new server.',
			);
		}

		// Recheck the current row inside the write owner, after the asynchronous upstream probe.
		const suppliedToken = input.accessToken?.trim();
		if (!suppliedToken && !canRetainMediaServerCredential(existing, input)) {
			throw new MediaServerPersistenceError(
				'The server connection changed while it was being checked. Reload the page and try again.',
			);
		}

		assertReportingProvider(existing.provider, input.playbackReportingEnabled ?? existing.playbackReportingEnabled);
		const name = input.name ?? existing.name;
		const nameKey = canonicalIdentityKey(name);
		await this.assertNameAvailable(nameKey, id);
		const replacements = input.pathReplacements ?? existing.pathReplacements;
		const token = suppliedToken || existing.accessToken;
		try {
			await this.db.update(mediaServers).set({
				name,
				nameKey,
				baseUrl: input.baseUrl ?? existing.baseUrl,
				serverName: inspection.serverName,
				clientIdentifier: input.clientIdentifier?.trim() || existing.clientIdentifier,
				accessToken: token,
				allowInsecureTls: input.allowInsecureTls ?? existing.allowInsecureTls,
				playbackReportingEnabled: input.playbackReportingEnabled ?? existing.playbackReportingEnabled,
				pathReplacements: replacements,
				updatedAt: currentTimestamp(),
			}).where(eq(mediaServers.id, id));
		}
		catch (error) {
			this.rethrowUnique(error);
		}

		const rescanLibraryIds = sameReplacements(existing.pathReplacements, replacements)
			? []
			: await this.libraryIdsForMediaServer(id);
		return { server: (await this.getMediaServer(id))!, rescanLibraryIds };
	}

	/** Delete a server that no library still references. */
	async deleteMediaServer(id: string): Promise<boolean> {
		return this.db.transaction(tx => {
			if (!tx.select({ id: mediaServers.id }).from(mediaServers).where(eq(mediaServers.id, id)).get()) {
				return false;
			}
			if (this.referencingLibraries(tx, id).limit(1).get()) {
				throw new MediaServerPersistenceError('Remove the libraries that use this server before deleting it');
			}

			return tx.delete(mediaServers).where(eq(mediaServers.id, id)).run().changes > 0;
		});
	}

	/**
	 * Libraries whose accepted source or pending source change points at this server.
	 * A pending attachment counts so the server cannot disappear before that change is accepted.
	 */
	async libraryIdsForMediaServer(id: string): Promise<string[]> {
		return this.referencingLibraries(this.db, id).all().map(row => row.id);
	}

	/** Find accepted and pending attachments using the caller's transaction when present. */
	private referencingLibraries(db: Pick<MoiraiDatabase, 'select'>, id: string) {
		return db.select({ id: libraries.id }).from(libraries).where(
			sql`json_extract(${libraries.sourceConfig}, '$.mediaServerId') = ${id}
				OR json_extract(${libraries.pendingSourceDefinition}, '$.sourceConfig.mediaServerId') = ${id}`,
		);
	}

	/** Drop the access token before a row leaves the server. */
	private publicServer(row: typeof mediaServers.$inferSelect): MediaServer {
		return {
			id: row.id,
			provider: row.provider,
			name: row.name,
			baseUrl: publicAddress(row.baseUrl),
			serverKey: row.serverKey,
			serverName: row.serverName,
			clientIdentifier: row.clientIdentifier,
			allowInsecureTls: row.allowInsecureTls,
			playbackReportingEnabled: row.playbackReportingEnabled,
			pathReplacements: row.pathReplacements,
			hasCredential: row.accessToken.length > 0,
			credentialPlaceholder: credentialPlaceholder(row.accessToken),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	/** Reject a display name another server already uses. */
	private async assertNameAvailable(nameKey: string, exceptId: string | null): Promise<void> {
		const [row] = await this.db.select({ id: mediaServers.id }).from(mediaServers)
			.where(eq(mediaServers.nameKey, nameKey)).limit(1);
		if (row && row.id !== exceptId) {
			throw new MediaServerPersistenceError('That server name is already in use');
		}
	}

	/** Reject a second record for the same provider installation. */
	private async assertServerAvailable(
		provider: MediaServer['provider'],
		serverKey: string,
		exceptId: string | null,
	): Promise<void> {
		const [row] = await this.db.select({ id: mediaServers.id }).from(mediaServers).where(
			sql`${mediaServers.provider} = ${provider} AND ${mediaServers.serverKey} = ${serverKey}`,
		).limit(1);
		if (row && row.id !== exceptId) {
			throw new MediaServerPersistenceError('That server is already saved');
		}
	}

	/** Turn a lost race on a unique index into the same conflict the pre-check reports. */
	private rethrowUnique(error: unknown): never {
		const message = error instanceof Error ? error.message : '';
		if (message.includes('UNIQUE') || message.includes('unique')) {
			throw new MediaServerPersistenceError('That server is already saved');
		}

		throw error;
	}
}

/** Reject reporting for providers whose playback lifecycle is not implemented. */
function assertReportingProvider(provider: MediaServer['provider'], enabled: boolean): void {
	if (enabled && !MEDIA_SERVER_PLAYBACK_REPORTING_PROVIDERS.some(value => value === provider)) {
		throw new MediaServerPersistenceError('Playback reporting is only available for Plex and Jellyfin', 400);
	}
}
