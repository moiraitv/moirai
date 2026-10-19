import { copyFile, cp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { assetRoots } from './format.js';
import { atomicJson, readJson, optionalStat } from './files.js';

/** Durable commit-forward intent; source staging survives until every replacement completes. */
const restoreJournalSchema = z.object({ staging: z.string(), authenticationCaptured: z.boolean() });

/** Preserve destination administrator identities only, invalidating every existing session/token. */
function preserveAuthentication(config: AppConfig, staging: string): void {
	const current = new Database(config.databasePath, { readonly: true });
	const restored = new Database(path.join(staging, 'restored.sqlite'));
	try {
		for (const table of ['authentication_initialization', 'authentication_identities']) {
			const rows = current.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, string | number | null>>;
			restored.prepare(`DELETE FROM ${table}`).run();
			for (const row of rows) {
				const names = Object.keys(row);
				restored.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...Object.values(row));
			}
		}
	}
	finally {
		current.close();
		restored.close();
	}
}
/** Reject overlapping storage roots before any destructive replacement or generated-data cleanup. */
function validateDestinations(config: AppConfig): void {
	const roots = [...Object.values(assetRoots(config)), config.artworkCacheDir, config.playbackStreamDir, config.playbackPlayoutDir].map(root => path.resolve(root));
	const protectedPaths = [config.databasePath, config.backupDir, path.join(config.dataDir, 'restore-staging')].map(root => path.resolve(root));
	for (const root of roots) {
		if (protectedPaths.some(target => target === root || target.startsWith(`${root}${path.sep}`))
			|| roots.some(other => other !== root && other.startsWith(`${root}${path.sep}`))
			|| roots.filter(other => other === root).length > 1) {
			throw new Error('Restore requires separate managed asset, generated data, database, backup, and staging locations');
		}
	}
}
/** Persist restore intent only after validation and a successful pre-restore recovery archive. */
export async function stageRestore(config: AppConfig, staging: string): Promise<void> {
	validateDestinations(config);
	await atomicJson(path.join(config.dataDir, 'restore-journal.json'), { staging, authenticationCaptured: false });
}
/** Replace a destination file via a temporary sibling, including across independently mounted volumes. */
async function replaceFile(source: string, target: string): Promise<void> {
	await mkdir(path.dirname(target), { recursive: true });
	await copyFile(source, `${target}.restore-tmp`);
	await rename(`${target}.restore-tmp`, target);
}
/** Clear managed contents without removing a root that may be a filesystem mount point. */
async function clearDirectory(root: string): Promise<void> {
	await mkdir(root, { recursive: true });
	for (const entry of await readdir(root)) {
		await rm(path.join(root, entry), { recursive: true, force: true });
	}
}
/** Resume a stopped restore before migrations; never open live consumers against partially replaced state. */
export async function resumeRestore(config: AppConfig): Promise<boolean> {
	const filename = path.join(config.dataDir, 'restore-journal.json');
	const journal = await readJson(filename, restoreJournalSchema);
	if (!journal) {
		return false;
	}
	validateDestinations(config);
	const stagingRoot = path.join(config.dataDir, 'restore-staging');
	if (path.dirname(journal.staging) !== stagingRoot) {
		throw new Error('Restore journal points outside private staging');
	}
	if (!journal.authenticationCaptured) {
		preserveAuthentication(config, journal.staging);
		journal.authenticationCaptured = true;
		await atomicJson(filename, journal);
	}
	// Every step can be repeated from immutable staging after an interrupted replacement.
	for (const [namespace, target] of Object.entries(assetRoots(config))) {
		// Clean up temporary siblings left by earlier interrupted restore implementations.
		await rm(`${target}.restore-tmp`, { recursive: true, force: true });
		await clearDirectory(target);
		const source = path.join(journal.staging, namespace);
		if (await optionalStat(source)) {
			await cp(source, target, { recursive: true, force: true });
		}
	}
	const ai = path.join(journal.staging, 'ai-settings.json');
	if (await optionalStat(ai)) {
		await replaceFile(ai, path.join(config.dataDir, 'ai-settings.json'));
	}
	else {
		await rm(path.join(config.dataDir, 'ai-settings.json'), { force: true });
	}
	await rm(`${config.databasePath}-wal`, { force: true });
	await rm(`${config.databasePath}-shm`, { force: true });
	await replaceFile(path.join(journal.staging, 'restored.sqlite'), config.databasePath);
	// Preserve output roots because operators can mount a filesystem at these locations.
	for (const generated of [config.artworkCacheDir, config.playbackStreamDir, config.playbackPlayoutDir]) {
		await clearDirectory(generated);
	}
	await rm(path.join(config.dataDir, 'backup-schedule.json'), { force: true });
	await rm(filename);
	await rm(journal.staging, { recursive: true, force: true });
	return true;
}
