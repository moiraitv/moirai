import type Database from 'better-sqlite3';
import { primaryGenreKey } from '../scanner/catalog-metadata.js';

/** Register the source-order resolver used by the additive primary-genre backfill. */
export function registerPrimaryGenreMigration(sqlite: Database.Database): void {
	sqlite.function('moirai_primary_genre', { deterministic: true }, (value) => {
		const metadata: unknown = typeof value === 'string' ? JSON.parse(value) : null;
		return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
			? primaryGenreKey(metadata as Record<string, unknown>) : null;
	});
}
