import type { Server } from 'node:http';
import type { AppConfig } from '../config.js';
import { ensurePrivateDirectory, protectPrivateDatabaseFiles } from '../operations/private-storage.js';
import { storageFailureMessage } from '../operations/storage-errors.js';
import { startBootstrapServer } from './bootstrap-http.js';

/** Check private storage before any database restore, backup, or migration can open it. */
export async function startStorageRecovery(
	config: Pick<AppConfig, 'dataDir' | 'databasePath' | 'host' | 'port'>,
): Promise<Server | undefined> {
	try {
		ensurePrivateDirectory(config.dataDir);
		protectPrivateDatabaseFiles(config.databasePath);
	}
	catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		const message = code === 'EPERM' || code === 'EACCES'
			? 'Moirai could not secure its private storage. Give the Moirai service account ownership of its data directory and any existing database files, then restart.'
			: `Moirai could not secure its private storage. ${storageFailureMessage(error) ?? 'Check the configured storage mounts.'} Restart after correcting storage.`;
		console.error(message);
		return startBootstrapServer(config.host, config.port, {
			status: 'failed', progress: { applied: 0, total: 0, percent: 0 }, error: message,
		});
	}
}
