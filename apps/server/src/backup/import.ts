import { BackupContentError, validationFailure } from './errors.js';
import { compatibleMigrationCount } from './migration-history.js';
import { validateConfigurationRecords } from './validate-records.js';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { backupSettingsSchema, playbackSettingsSchema, CHANNEL_LOGO_MAX_BYTES, GUIDE_ARTWORK_MAX_BYTES, FALLBACK_FILLER_MAX_BYTES } from '@moirai/shared';
import { backupAiPreferences } from '../ai/settings.js';
import { validateChannelLogo } from '../artwork/channel-logo-store.js';
import { normalizeGuideArtwork } from '../artwork/guide-artwork-store.js';
import { applyNextMigration, applyPendingMigrations } from '../db/migrations.js';
import { rebuildCatalogSearchForLibrary } from '../repository/catalog-search-sql.js';
import { foldMusicSearchText } from '../media/music-search.js';
import type { BackupManifest, BackupPaths } from './format.js';
import { atomicJson, recordSizeGuard } from './files.js';
import { validateFallbackAssets } from './validate-assets.js';

/** Identifiers that own resources or reference indexed/configured records must remain safe UUIDs. */
const uuidColumns = new Set(['id', 'library_id', 'group_id', 'parent_id', 'item_id', 'alias_id',
	'media_item_id', 'show_group_id', 'channel_id', 'program_id', 'template_id', 'default_template_id',
	'default_program_id', 'media_id']);

/** Return columns from trusted locally-created tables, never archive-provided identifiers. */
function columns(sqlite: Database.Database, table: string): string[] {
	return (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(column => column.name);
}
/** Import streamed rows with bound values, rejecting unknown columns and duplicate primary keys. */
async function importTable(sqlite: Database.Database, table: string, filename: string): Promise<void> {
	const names = columns(sqlite, table);
	if (!names.length) {
		throw new BackupContentError('Backup contains a table unavailable in its schema version');
	}
	sqlite.prepare(`DELETE FROM "${table}"`).run();
	const insert = sqlite.prepare(`INSERT INTO "${table}" (${names.map(name => `"${name}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`);
	const source = createReadStream(filename);
	const input = source.pipe(recordSizeGuard());
	source.on('error', error => input.destroy(error));
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			const row = z.record(z.string(), z.union([z.string(), z.number(), z.null()])).parse(JSON.parse(line));
			if (Object.keys(row).length !== names.length || names.some(name => !(name in row))) {
				throw new BackupContentError('Backup row columns do not match the trusted schema');
			}
			for (const name of names) {
				if (uuidColumns.has(name) && row[name] !== null) {
					z.uuid().parse(row[name]);
				}
			}
			insert.run(...names.map(name => row[name]));
		}
	}
	finally {
		lines.close();
		input.destroy();
		source.destroy();
	}
}
/** Build and migrate an isolated database entirely from trusted migrations and bound record values. */
export async function prepareDatabase(config: BackupPaths, staging: string, manifest: BackupManifest, progress: (label: string) => void = () => {}): Promise<{ libraries: number; channels: number; mediaItems: number }> {
	progress('Reconstructing database (2/4)…');
	const migrationCount = compatibleMigrationCount(manifest.migrations, config.migrationsDir);
	const sqlite = new Database(path.join(staging, 'restored.sqlite'));
	try {
		sqlite.function('moirai_music_fold', { deterministic: true }, value => typeof value === 'string' ? foldMusicSearchText(value) : null);
		sqlite.pragma('foreign_keys = OFF');
		for (let index = 0; index < migrationCount; index += 1) {
			applyNextMigration(sqlite, config.migrationsDir);
		}
		if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'catalog_search_defer'").get()) {
			sqlite.exec('INSERT INTO catalog_search_defer (defer) VALUES (1)');
		}
		sqlite.exec('BEGIN');
		for (const table of manifest.tables) {
			await importTable(sqlite, table, path.join(staging, 'tables', `${table}.ndjson`));
		}
		sqlite.exec('COMMIT');
		applyPendingMigrations(sqlite, config.migrationsDir);
		// Derived search and operational state must describe the restored durable catalog.
		sqlite.exec("UPDATE libraries SET watcher_status = 'stopped'; DELETE FROM catalog_search_defer;");
		for (const row of sqlite.prepare('SELECT id FROM libraries').all() as Array<{ id: string }>) {
			rebuildCatalogSearchForLibrary(sqlite, row.id);
		}
		progress('Checking configuration and relationships (3/4)…');
		for (const row of sqlite.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>) {
			if (row.key === 'backups') {
				backupSettingsSchema.parse(JSON.parse(row.value));
			}
			else if (row.key === 'playback') {
				playbackSettingsSchema.parse(JSON.parse(row.value));
			}
			else {
				throw new BackupContentError('Backup contains an unsupported settings key');
			}
		}
		if ((sqlite.pragma('foreign_key_check') as unknown[]).length || sqlite.pragma('integrity_check', { simple: true }) !== 'ok') {
			throw new BackupContentError('Restored configuration failed database integrity validation');
		}
		validateConfigurationRecords(sqlite);
		try {
			progress('Checking managed assets (4/4)…');
			await validateAssets(config, staging, manifest);
		}
		catch (error) {
			throw validationFailure('backup_invalid_assets', error);
		}
		const count = (table: string): number => (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
		return { libraries: count('libraries'), channels: count('channels'), mediaItems: count('media_items') };
	}
	catch (error) {
		throw validationFailure('backup_invalid_records', error);
	}
	finally {
		sqlite.close();
	}
}
/** Validate managed image contents and sanitize AI preferences again at the import boundary. */
async function validateAssets(config: BackupPaths, staging: string, manifest: BackupManifest): Promise<void> {
	for (const entry of manifest.entries) {
		const filename = path.join(staging, entry.name);
		if (entry.name.startsWith('channel-logos/')) {
			if ((await stat(filename)).size > CHANNEL_LOGO_MAX_BYTES) {
				throw new BackupContentError('Channel logo exceeds its upload limit');
			}
			await validateChannelLogo(await readFile(filename));
		}
		else if (entry.name.startsWith('guide-artwork/')) {
			if ((await stat(filename)).size > GUIDE_ARTWORK_MAX_BYTES) {
				throw new BackupContentError('Guide artwork exceeds its upload limit');
			}
			await normalizeGuideArtwork(await readFile(filename));
		}
		else if (entry.name.endsWith('/asset') && entry.size > FALLBACK_FILLER_MAX_BYTES) {
			throw new BackupContentError('Fallback video exceeds its upload limit');
		}
		else if (entry.name === 'ai-settings.json') {
			await atomicJson(filename, backupAiPreferences(JSON.parse(await readFile(filename, 'utf8'))));
		}
	}
	await validateFallbackAssets(config, staging, manifest);
}
