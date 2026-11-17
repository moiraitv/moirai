import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';

/** Create and harden only the explicitly application-owned directory, not its ancestors. */
export function ensurePrivateDirectory(directory: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
}

/** Restrict an existing private artifact while allowing an absent optional sidecar. */
export function protectPrivateFile(file: string): void {
	try {
		chmodSync(file, 0o600);
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
}

/** Harden existing SQLite files without creating a database during startup preflight. */
export function protectPrivateDatabaseFiles(databasePath: string): void {
	if (databasePath === ':memory:') {
		return;
	}

	for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
		protectPrivateFile(file);
	}
}

/**
 * Prepare an owner-only database before SQLite can create its journal or memory files.
 * Existing custom parent directories retain their permissions and all contents are preserved.
 */
export function preparePrivateDatabase(databasePath: string): void {
	if (databasePath === ':memory:') {
		return;
	}

	mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
	try {
		closeSync(openSync(databasePath, 'wx', 0o600));
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}
	}

	protectPrivateDatabaseFiles(databasePath);
}
