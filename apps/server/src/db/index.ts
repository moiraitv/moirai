import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { foldMusicSearchText } from '../media/music-search.js';
import {
	endCatalogSearchDefer,
	ensureCatalogSearchDeferTable,
} from '../repository/catalog-search-sql.js';
import * as schema from './schema.js';
import * as semanticSchema from './semantic-schema.js';

/** Database handle to the SQLite connection. */
export type MoiraiDatabase = ReturnType<typeof createDatabase>['db'];

/** Open and configure the single-process SQLite database. */
export function createDatabase(databasePath: string, migrationsDir: string) {
	if (databasePath !== ':memory:') {
		mkdirSync(path.dirname(databasePath), { recursive: true });
	}

	const sqlite = new Database(databasePath);
	sqlite.function('moirai_music_fold', { deterministic: true }, value =>
		typeof value === 'string' ? foldMusicSearchText(value) : null);
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('busy_timeout = 5000');
	if (databasePath !== ':memory:') {
		sqlite.pragma('journal_mode = WAL');
	}

	const db = drizzle(sqlite, { schema: { ...schema, ...semanticSchema } });
	migrate(db, { migrationsFolder: migrationsDir });
	ensureCatalogSearchDeferTable(sqlite);
	endCatalogSearchDefer(sqlite);
	return { db, sqlite, close: () => sqlite.close() };
}
