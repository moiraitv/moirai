import type Database from 'better-sqlite3';

/** Open SQLite connection used to rebuild or defer catalog search. */
type SqliteDatabase = Database.Database;

/** Item search body using the `i` alias for bulk rebuilds. */
const ITEM_BODY_FROM_I = `trim(
	i.title || ' ' || COALESCE(i.plot, '') || ' ' ||
	COALESCE((SELECT title FROM media_groups WHERE id = i.group_id), '') || ' ' ||
	COALESCE((SELECT parent.title FROM media_groups g JOIN media_groups parent ON parent.id = g.parent_id WHERE g.id = i.group_id), '') || ' ' ||
	COALESCE((SELECT group_concat(name || ' ' || normalized_name, ' ') FROM media_item_people WHERE item_id = i.id), '') || ' ' ||
	COALESCE((SELECT group_concat(genre_name || ' ' || genre_key, ' ') FROM media_item_genres WHERE item_id = i.id), '')
)`;

/** Create the flag table used to skip FTS triggers during catalog persist. */
export function ensureCatalogSearchDeferTable(sqlite: SqliteDatabase): void {
	sqlite.exec('CREATE TABLE IF NOT EXISTS catalog_search_defer (defer INTEGER NOT NULL)');
}

/** Pause live FTS triggers for the current connection. */
export function beginCatalogSearchDefer(sqlite: SqliteDatabase): void {
	ensureCatalogSearchDeferTable(sqlite);
	sqlite.exec('INSERT INTO catalog_search_defer (defer) VALUES (1)');
}

/** Resume live FTS triggers for the current connection. */
export function endCatalogSearchDefer(sqlite: SqliteDatabase): void {
	sqlite.exec('DELETE FROM catalog_search_defer');
}

/** Skip live FTS triggers for the duration of one catalog rewrite. */
export function withCatalogSearchDefer(sqlite: SqliteDatabase, work: () => void): void {
	beginCatalogSearchDefer(sqlite);
	try {
		work();
	}
	finally {
		endCatalogSearchDefer(sqlite);
	}
}

/** Replace FTS rows for one library after a deferred catalog persist. */
export function rebuildCatalogSearchForLibrary(sqlite: SqliteDatabase, libraryId: string): void {
	sqlite.prepare('DELETE FROM catalog_search WHERE library_id = ?').run(libraryId);
	sqlite.prepare(`
		INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
		SELECT library_id, id, 'group', trim(title || ' ' || COALESCE(plot, ''))
		FROM media_groups WHERE library_id = ?
	`).run(libraryId);
	sqlite.prepare(`
		INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
		SELECT i.library_id, i.id, 'item', ${ITEM_BODY_FROM_I}
		FROM media_items i WHERE i.library_id = ?
	`).run(libraryId);
}
