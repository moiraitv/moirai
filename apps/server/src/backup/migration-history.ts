import { readMigrationJournal } from '../db/migrations.js';
import type { BackupManifest } from './format.js';
import { BackupValidationError } from './errors.js';

/**
 * Resolve a supported journal prefix by identity, as startup does. Historical SQL hashes remain
 * provenance; trusted reconstruction and exact record-column checks establish schema compatibility.
 */
export function compatibleMigrationCount(markers: BackupManifest['migrations'], migrationsDir: string): number {
	const journal = readMigrationJournal(migrationsDir);
	const latest = Math.max(...journal.map(entry => entry.when));
	const identities = new Map<number, string>();
	for (const marker of markers) {
		if (marker.createdAt > latest) {
			throw new BackupValidationError('backup_unsupported_schema', { name: 'MigrationHistory', reason: 'future_migration' });
		}
		if (identities.has(marker.createdAt) && identities.get(marker.createdAt) !== marker.hash) {
			throw new BackupValidationError('backup_unsupported_schema', { name: 'MigrationHistory', reason: 'conflicting_duplicate' });
		}
		identities.set(marker.createdAt, marker.hash);
	}

	let count = 0;
	let missing = false;
	for (const entry of journal) {
		if (!identities.has(entry.when)) {
			missing = true;
		}
		else if (missing) {
			throw new BackupValidationError('backup_unsupported_schema', { name: 'MigrationHistory', reason: 'noncontiguous_history' });
		}
		else {
			count += 1;
		}
	}
	if (!count) {
		throw new BackupValidationError('backup_unsupported_schema', { name: 'MigrationHistory', reason: 'missing_supported_history' });
	}
	return count;
}
