import { clearBackupWarning, type BackupWarning } from './warnings.js';
import { storageFailureMessage } from '../operations/storage-errors.js';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { UPGRADE_BACKUP_RETENTION } from '@moirai/shared';
import type { AppConfig } from '../config.js';
import { migrationProgressFromSqlite } from '../db/migrations.js';
import { atomicJson, readJson, optionalStat } from './files.js';
import { BackupStore } from './store.js';
import { runBackupWorker } from './run-worker.js';
import { applicationVersion } from '../version.js';

/** Last application version that successfully opened services; migrations remain an independent trigger. */
const versionSchema = z.object({ version: z.string() });

/** Check upgrade recovery before any migration mutates an existing installation. */
export async function prepareUpgradeBackup(config: AppConfig): Promise<void> {
	const store = new BackupStore(config.backupDir);
	let failureKind: BackupWarning['kind'] = 'upgrade';
	try {
		await store.prune('upgrade', UPGRADE_BACKUP_RETENTION).then(() => clearBackupWarning(config.dataDir, ['upgrade-cleanup'])).catch(async error => {
			await atomicJson(path.join(config.dataDir, 'backup-warning.json'), { kind: 'upgrade-cleanup', message: `Upgrade recovery cleanup failed. ${storageFailureMessage(error) ?? 'Check backup storage.'}` }).catch(() => undefined);
		});
		if (!(await optionalStat(config.databasePath))?.size) {
			return;
		}
		const sqlite = new Database(config.databasePath, { readonly: true });
		let needed = false;
		try {
			const populated = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'libraries'").get();
			if (!populated) {
				return;
			}
			const previous = await readJson(path.join(config.dataDir, 'last-started-version.json'), versionSchema);
			const progress = migrationProgressFromSqlite(sqlite, config.migrationsDir);
			needed = previous?.version !== applicationVersion || progress.applied < progress.total;
		}
		finally {
			sqlite.close();
		}
		if (needed) {
			const staging = await store.staging();
			try {
				await runBackupWorker({ action: 'create', config, directory: config.backupDir, staging, kind: 'upgrade', version: applicationVersion });
				failureKind = 'upgrade-cleanup';
			}
			finally {
				await store.cleanup(staging);
			}
			await store.prune('upgrade', UPGRADE_BACKUP_RETENTION);
			await clearBackupWarning(config.dataDir, ['upgrade', 'upgrade-cleanup']);
		}
	}
	catch (error) {
		const message = `Upgrade recovery backup or cleanup failed. Startup will continue; check the backup volume and available space. ${storageFailureMessage(error) ?? ''}`.trim();
		console.warn(message);
		await atomicJson(path.join(config.dataDir, 'backup-warning.json'), { message, kind: failureKind }).catch(() => undefined);
	}
}

/** Record successful startup only after services are available. */
export async function recordStartedVersion(config: AppConfig): Promise<void> {
	await atomicJson(path.join(config.dataDir, 'last-started-version.json'), { version: applicationVersion });
}
