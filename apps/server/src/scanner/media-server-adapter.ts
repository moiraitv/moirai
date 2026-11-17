import {
	isOnDiskSourceConfig,
	remoteLibrarySourceConfigSchema,
	type Library,
	type RemoteLibrarySourceConfig,
	type SourceIdentity,
} from '@moirai/shared';
import type { MediaProbe } from '../media/media-probe.js';
import { buildRemoteCatalog } from '../media-servers/catalog.js';
import { openMediaServerClient } from '../media-servers/client.js';
import { createMediaFetch, type MediaFetch } from '../media-servers/http.js';
import type { RemoteLibraryType } from '../media-servers/items.js';
import type { MediaServerRepository } from '../repository/media-servers.js';
import type {
	LibrarySourceAdapter,
	MissingItemPresenceCheck,
	MissingItemPresenceTarget,
	PresenceCheckContext,
	ScanContext,
	ScanDiscovery,
	SourceConfigurationImpact,
} from './contracts.js';
import { InvalidLibrarySourceConfigurationError } from './contracts.js';

/** Library types a remote adapter can index. */
const REMOTE_LIBRARY_TYPES = ['movies', 'shows', 'music-videos', 'other'] as const;

/**
 * Index one Plex, Jellyfin, or Emby library through the shared catalog shape.
 * The adapter does not watch the remote server. Connection failures throw so the scanner
 * keeps the previous index and marks the library unavailable.
 */
export class MediaServerSourceAdapter implements LibrarySourceAdapter {
	/**
	 * Mapped local files reuse a probe when the file fingerprint still matches.
	 * Items that stream from the server are stored complete, so this does not schedule
	 * a startup scan unless a local probe failed.
	 */
	readonly usesMediaProbeCache = true;

	constructor(
		readonly sourceType: 'plex' | 'jellyfin' | 'emby',
		private readonly servers: Pick<MediaServerRepository, 'getMediaServerConnection'>,
		private readonly mediaProbe?: MediaProbe,
		private readonly fetchFor: (allowInsecureTls: boolean) => MediaFetch = createMediaFetch,
	) {}

	/** Validate the source shape. The library writer checks the connection before saving. */
	async validateConfig(config: unknown): Promise<void> {
		if (!remoteLibrarySourceConfigSchema.safeParse(config).success) {
			throw new InvalidLibrarySourceConfigurationError('Choose a library on a saved media server');
		}
	}

	/** Replacing the server or the remote library replaces the indexed source. */
	configurationImpact(previous: unknown, next: unknown): SourceConfigurationImpact {
		const prior = remoteLibrarySourceConfigSchema.parse(previous);
		const current = remoteLibrarySourceConfigSchema.parse(next);
		if (prior.mediaServerId !== current.mediaServerId || prior.remoteLibraryId !== current.remoteLibraryId) {
			return 'identity';
		}

		return 'none';
	}

	/** List the remote library and map it into the catalog, probing local files when a mapping hits. */
	async discover(library: Library, context: ScanContext): Promise<ScanDiscovery> {
		if (isOnDiskSourceConfig(library.sourceConfig) || library.sourceType !== this.sourceType) {
			throw new Error('Media server scan received a different library source');
		}

		const typeKey = remoteType(library.typeKey);
		const connection = await this.servers.getMediaServerConnection(library.sourceConfig.mediaServerId);
		if (!connection || connection.provider !== this.sourceType) {
			throw new Error('The media server for this library is no longer saved');
		}

		context.onProgress({ phase: 'discovering', processedCount: 0, totalCount: null });
		const client = openMediaServerClient(this.fetchFor(connection.allowInsecureTls), connection);
		const remoteItems = await client.listItems(library.sourceConfig.remoteLibraryId, typeKey, context.signal);
		context.onProgress({
			phase: 'processing',
			processedCount: 0,
			totalCount: remoteItems.length,
		});
		const catalog = await buildRemoteCatalog({
			libraryId: library.id,
			mediaServerId: connection.id,
			items: remoteItems,
			replacements: connection.pathReplacements,
			probeCache: context.probeCache,
			signal: context.signal,
			...(this.mediaProbe
				? {
					probe: this.mediaProbe,
					inspectTail: this.mediaProbe.inspectTail.bind(this.mediaProbe),
				}
				: {}),
			...(context.tailAssessments ? { tailAssessments: context.tailAssessments } : {}),
		});
		context.onProgress({
			phase: 'finalizing',
			processedCount: remoteItems.length,
			totalCount: remoteItems.length,
		});
		return {
			...catalog,
			traversalComplete: true,
			sourceIdentity: sourceIdentity(this.sourceType, connection.serverKey, library.sourceConfig),
		};
	}

	/** Ask the provider whether each missing item id still exists. Network failures stay inconclusive. */
	async checkPresence(
		library: Library,
		targets: MissingItemPresenceTarget[],
		context: PresenceCheckContext,
	): Promise<MissingItemPresenceCheck> {
		if (isOnDiskSourceConfig(library.sourceConfig) || library.sourceType !== this.sourceType) {
			throw new Error('Media server presence check received a different library source');
		}

		const connection = await this.servers.getMediaServerConnection(library.sourceConfig.mediaServerId);
		if (!connection || connection.provider !== this.sourceType) {
			throw new Error('The media server for this library is no longer saved');
		}

		const client = openMediaServerClient(this.fetchFor(connection.allowInsecureTls), connection);
		const observations = await mapLimited(targets, this.mediaProbe?.concurrencyLimit ?? 4, async (target) => {
			context.signal.throwIfAborted();
			try {
				const present = await client.itemExists(target.stableKey, context.signal);
				return { itemId: target.itemId, status: present ? 'present' as const : 'absent' as const };
			}
			catch (error) {
				if (context.signal.aborted) {
					throw error;
				}

				return { itemId: target.itemId, status: 'inconclusive' as const };
			}
		});
		return {
			sourceIdentity: sourceIdentity(this.sourceType, connection.serverKey, library.sourceConfig),
			observations,
		};
	}
}

/** Identity key shared by a full scan and a later presence check. */
function sourceIdentity(
	provider: 'plex' | 'jellyfin' | 'emby',
	serverKey: string,
	config: RemoteLibrarySourceConfig,
): SourceIdentity {
	return {
		sourceType: provider,
		sourceKey: `${provider}:${serverKey}:${config.remoteLibraryId}`,
		details: {
			serverKey,
			remoteLibraryId: config.remoteLibraryId,
			remoteLibraryName: config.remoteLibraryName,
		},
	};
}

/** Accept only library types the remote clients know how to page. */
function remoteType(typeKey: string): RemoteLibraryType {
	if ((REMOTE_LIBRARY_TYPES as readonly string[]).includes(typeKey)) {
		return typeKey as RemoteLibraryType;
	}

	throw new Error(`This media server cannot index library type ${typeKey}`);
}

/** Run a small pool without putting remote checks on the filesystem scan queue. */
async function mapLimited<T, R>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;

	/** Claim the next index until the list is exhausted. */
	async function run(): Promise<void> {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await worker(items[index]!);
		}
	}

	const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, () => run());
	await Promise.all(workers);
	return results;
}
