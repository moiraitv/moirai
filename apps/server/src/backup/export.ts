import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, lstat, readFile, writeFile, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import yazl from 'yazl';
import type { BackupInfo } from '@moirai/shared';
import { backupFilename, BACKUP_MAX_BYTES, BACKUP_MAX_EXPANDED_BYTES, BACKUP_MAX_ENTRIES } from '@moirai/shared';
import { backupAiPreferences } from '../ai/settings.js';
import { assetRoots, allowedEntry, BACKUP_TABLES, type BackupPaths, type BackupManifest } from './format.js';
import { fileDigest } from './files.js';

/** Export only durable rows from a consistent read transaction into bounded streaming records. */
async function exportTables(config: BackupPaths, staging: string): Promise<Pick<BackupManifest, 'tables' | 'migrations'>> {
	const sqlite = new Database(config.databasePath, { readonly: true, fileMustExist: true });
	const tables: BackupManifest['tables'] = [];
	try {
		sqlite.exec('BEGIN');
		const existing = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name));
		const migrations = existing.has('__drizzle_migrations')
			? sqlite.prepare('SELECT created_at AS createdAt, hash FROM __drizzle_migrations ORDER BY created_at').all() as BackupManifest['migrations'] : [];
		await mkdir(path.join(staging, 'tables'), { recursive: true });
		for (const table of BACKUP_TABLES) {
			if (!existing.has(table)) {
				continue;
			}
			tables.push(table);
			const output = createWriteStream(path.join(staging, 'tables', `${table}.ndjson`), { mode: 0o600 });
			try {
				for (const row of sqlite.prepare(`SELECT * FROM "${table}"${table === 'media_tail_assessments' ? ' WHERE accepted = 1' : ''}`).iterate() as Iterable<Record<string, unknown>>) {
					// Scan history is excluded, while durable removal observations must remain restorable.
					if (table === 'media_removal_tombstones' && 'last_scan_id' in row) {
						row.last_scan_id = null;
					}
					const record = `${JSON.stringify(row)}\n`;
					if (Buffer.byteLength(record) > 64 * 1024 ** 2) {
						throw new Error('Backup record exceeds 64 MiB');
					}
					if (!output.write(record)) {
						await once(output, 'drain');
					}
				}
				output.end();
				await once(output, 'finish');
			}
			finally {
				output.destroy();
			}
		}
		return { tables, migrations };
	}
	finally {
		sqlite.close();
	}
}
/** Copy only published managed files; reject symlinks rather than following them. */
async function captureAssets(root: string, namespace: string, staging: string, prefix = ''): Promise<void> {
	let names: string[];
	try {
		names = await readdir(path.join(root, prefix));
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return;
		}
		throw error;
	}
	for (const name of names) {
		const relative = prefix ? `${prefix}/${name}` : name;
		const filename = path.join(root, relative);
		const info = await lstat(filename);
		if (info.isSymbolicLink()) {
			throw new Error('Managed backup assets cannot be symbolic links');
		}
		if (info.isDirectory() && relative.split('/').length < 4) {
			await captureAssets(root, namespace, staging, relative);
		}
		else if (info.isFile() && allowedEntry(`${namespace}/${relative}`)) {
			const target = path.join(staging, namespace, relative);
			await mkdir(path.dirname(target), { recursive: true });
			await copyFile(filename, target);
		}
	}
}
/** Enumerate private captured files for manifest checksums and ZIP streaming. */
async function stagedFiles(root: string, prefix = ''): Promise<string[]> {
	const result: string[] = [];
	for (const name of await readdir(path.join(root, prefix), { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${name.name}` : name.name;
		if (name.isDirectory()) {
			result.push(...await stagedFiles(root, relative));
		}
		else {
			result.push(relative);
		}
	}
	return result;
}
/** Capture a portable configuration, release mutation protection, then compress and publish it. */
export async function createArchive(
	config: BackupPaths, 
	directory: string, 
	staging: string, 
	kind: BackupInfo['kind'], 
	applicationVersion: string,
	captured: () => void = () => {},
): Promise<BackupInfo> {
	const data = await exportTables(config, staging);
	for (const [namespace, root] of Object.entries(assetRoots(config))) {
		await captureAssets(root, namespace, staging);
	}
	try {
		const ai = backupAiPreferences(JSON.parse(await readFile(path.join(config.dataDir, 'ai-settings.json'), 'utf8')));
		await writeFile(path.join(staging, 'ai-settings.json'), JSON.stringify(ai), { mode: 0o600 });
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	captured();

	const id = randomUUID();
	const createdAt = new Date().toISOString();
	const entries: BackupManifest['entries'] = [];
	let expanded = 0;
	for (const name of await stagedFiles(staging)) {
		const digest = await fileDigest(path.join(staging, name));
		expanded += digest.size;
		if (expanded > BACKUP_MAX_EXPANDED_BYTES || entries.length >= BACKUP_MAX_ENTRIES - 1) {
			throw new Error('Configuration exceeds backup limits');
		}
		entries.push({ name, ...digest });
	}
	const manifest: BackupManifest = { formatVersion: 1, id, createdAt, kind, applicationVersion, ...data, entries };
	const archive = new yazl.ZipFile();
	const temporary = path.join(directory, `${id}.partial`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		const output = pipeline(archive.outputStream, createWriteStream(temporary, { mode: 0o600 }));
		for (const entry of entries) {
			archive.addFile(path.join(staging, entry.name), entry.name);
		}
		archive.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
		archive.end();
		await output;
		const size = (await stat(temporary)).size;
		if (size > BACKUP_MAX_BYTES) {
			throw new Error('Configuration exceeds compressed backup limit');
		}
		await rename(temporary, path.join(directory, backupFilename({ id, createdAt })));
		return { id, createdAt, kind, applicationVersion, size };
	}
	finally {
		await rm(temporary, { force: true });
	}
}
