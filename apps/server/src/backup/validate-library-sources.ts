import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { canonicalIdentityKey, MEDIA_SERVER_PLAYBACK_REPORTING_PROVIDERS, libraryCreateSchema, mediaServerCreateSchema } from '@moirai/shared';
import { libraries, mediaServers } from '../db/schema.js';
import { normalizeBaseUrl } from '../media-servers/http.js';
import { assertAbsoluteLocalPrefixes } from '../media-servers/paths.js';
import { BackupContentError } from './errors.js';

/** Validate restored server definitions and accepted/pending library references without network I/O. */
export function validateLibrarySources(sqlite: Database.Database): void {
	const db = drizzle(sqlite);
	const connections = db.select().from(mediaServers).all();
	const byId = new Map(connections.map(connection => [connection.id, connection]));
	for (const connection of connections) {
		mediaServerCreateSchema.omit({ accessToken: true }).parse(connection);
		if (connection.accessToken !== '' || connection.nameKey !== canonicalIdentityKey(connection.name)
			|| normalizeBaseUrl(connection.baseUrl) !== connection.baseUrl
			|| (connection.playbackReportingEnabled && !MEDIA_SERVER_PLAYBACK_REPORTING_PROVIDERS.some(provider => provider === connection.provider))) {
			throw new BackupContentError('Backup contains an invalid media server definition or a saved credential');
		}
		assertAbsoluteLocalPrefixes(connection.pathReplacements);
	}

	for (const library of db.select().from(libraries).all()) {
		for (const definition of [library, ...(library.pendingSourceDefinition ? [{ ...library, ...library.pendingSourceDefinition }] : [])]) {
			const source = libraryCreateSchema.parse(definition);
			if (source.sourceType !== 'on-disk' && byId.get(source.sourceConfig.mediaServerId)?.provider !== source.sourceType) {
				throw new BackupContentError('Backup library references a missing or incompatible media server');
			}
		}
	}
}
