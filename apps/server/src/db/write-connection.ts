import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { foldMusicSearchText } from '../media/music-search.js';
import * as schema from './schema.js';
import * as semanticSchema from './semantic-schema.js';

/** Open the runtime write owner after startup migrations, without rerunning upgrade work. */
export function openWriteDatabase(databasePath: string) {
	const sqlite = new Database(databasePath, { fileMustExist: true });
	sqlite.function('moirai_music_fold', { deterministic: true }, value =>
		typeof value === 'string' ? foldMusicSearchText(value) : null);
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('busy_timeout = 5000');
	const db = drizzle(sqlite, { schema: { ...schema, ...semanticSchema } });
	return { db, sqlite, close: () => sqlite.close() };
}
