import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

/** One Drizzle journal entry used to apply SQL files in order. */
interface JournalEntry {
	idx: number;
	when: number;
	tag: string;
}

/** Public migration progress reported to the bootstrap status page. */
export interface MigrationProgress {
	applied: number;
	total: number;
	percent: number;
	currentTag?: string;
}

/** Read the ordered Drizzle journal from a migrations folder. */
export function readMigrationJournal(migrationsDir: string): JournalEntry[] {
	const journalPath = path.join(migrationsDir, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };
	return [...journal.entries].sort((left, right) => left.idx - right.idx);
}

/** Count applied Drizzle markers without throwing when the table does not exist yet. */
export function countAppliedMigrations(sqlite: Database.Database): number {
	const exists = sqlite.prepare(
		'SELECT 1 AS present FROM sqlite_master WHERE type = \'table\' AND name = \'__drizzle_migrations\'',
	).get() as { present: number } | undefined;
	if (!exists) {
		return 0;
	}

	const row = sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get() as {
		count: number;
	};
	return row.count;
}

/** Derive applied/total progress from an open SQLite handle and the journal. */
export function migrationProgressFromSqlite(
	sqlite: Database.Database,
	migrationsDir: string,
): MigrationProgress {
	const journal = readMigrationJournal(migrationsDir);
	const applied = Math.min(countAppliedMigrations(sqlite), journal.length);
	const current = journal[applied];
	return {
		applied,
		total: journal.length,
		percent: journal.length === 0 ? 100 : Math.floor((applied / journal.length) * 100),
		...(current ? { currentTag: current.tag } : {}),
	};
}

/** SHA-256 hex digest Drizzle stores for one migration file. */
export function migrationFileHash(sql: string): string {
	return createHash('sha256').update(sql).digest('hex');
}

/** Apply one pending journal file using the same markers Drizzle migrate() writes. */
export function applyNextMigration(
	sqlite: Database.Database,
	migrationsDir: string,
): MigrationProgress {
	sqlite.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		hash text NOT NULL,
		created_at numeric
	)`);
	const journal = readMigrationJournal(migrationsDir);
	const appliedTimes = new Set(
		(sqlite.prepare('SELECT created_at AS createdAt FROM __drizzle_migrations').all() as Array<{
			createdAt: number;
		}>).map((row) => Number(row.createdAt)),
	);
	const next = journal.find((entry) => !appliedTimes.has(entry.when));
	if (!next) {
		return migrationProgressFromSqlite(sqlite, migrationsDir);
	}

	const sql = readFileSync(path.join(migrationsDir, `${next.tag}.sql`), 'utf8');
	const statements = sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean);
	const apply = sqlite.transaction(() => {
		for (const statement of statements) {
			sqlite.exec(statement);
		}
		sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(
			migrationFileHash(sql),
			next.when,
		);
	});
	apply();
	return migrationProgressFromSqlite(sqlite, migrationsDir);
}

/** Apply every pending journal file, invoking `onProgress` after each file. */
export function applyPendingMigrations(
	sqlite: Database.Database,
	migrationsDir: string,
	onProgress?: (progress: MigrationProgress) => void,
): MigrationProgress {
	let progress = migrationProgressFromSqlite(sqlite, migrationsDir);
	onProgress?.(progress);
	while (progress.applied < progress.total) {
		progress = applyNextMigration(sqlite, migrationsDir);
		onProgress?.(progress);
	}
	return progress;
}

/** Spawn the migration worker and resolve when it reports done. */
export function runMigrationsInWorker(
	databasePath: string,
	migrationsDir: string,
	onProgress: (progress: MigrationProgress) => void,
): Promise<void> {
	const compiled = new URL('./migrate-worker.js', import.meta.url);
	const workerUrl = existsSync(fileURLToPath(compiled))
		? compiled
		: new URL('./migrate-worker.ts', import.meta.url);
	const execArgv = workerUrl.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [];
	return new Promise((resolve, reject) => {
		const worker = new Worker(workerUrl, {
			workerData: { databasePath, migrationsDir },
			execArgv,
		});
		let settled = false;
		const finish = (action: () => void): void => {
			if (settled) {
				return;
			}

			settled = true;
			action();
		};

		let failure: Error | undefined;
		worker.on('message', (message: { type: string; progress?: MigrationProgress; message?: string }) => {
			if (message.type === 'progress' && message.progress) {
				onProgress(message.progress);
				return;
			}
			if (message.type === 'error') {
				failure = new Error(message.message ?? 'Migration worker failed');
				void worker.terminate();
			}
		});
		worker.on('error', (error) => {
			failure = error;
		});
		worker.on('exit', (code) => {
			if (failure) {
				finish(() => reject(failure));
				return;
			}
			if (code !== 0) {
				finish(() => reject(new Error(`Migration worker exited with code ${code}`)));
				return;
			}

			finish(() => resolve());
		});
	});
}
