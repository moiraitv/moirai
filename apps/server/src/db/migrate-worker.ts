import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { applyPendingMigrations } from './migrations.js';

const { databasePath, migrationsDir } = workerData as {
	databasePath: string;
	migrationsDir: string;
};

const sqlite = new Database(databasePath);
try {
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('busy_timeout = 5000');
	if (databasePath !== ':memory:') {
		sqlite.pragma('journal_mode = WAL');
	}

	applyPendingMigrations(sqlite, migrationsDir, (progress) => {
		parentPort?.postMessage({ type: 'progress', progress });
	});
	parentPort?.postMessage({ type: 'done' });
}
catch (error) {
	parentPort?.postMessage({
		type: 'error',
		message: error instanceof Error ? error.message : String(error),
	});
}
finally {
	sqlite.close();
}
