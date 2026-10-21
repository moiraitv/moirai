import { mkdtemp, mkdir, readFile, writeFile, rm, cp, readdir, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import yazl from 'yazl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@server/config.js';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { createArchive } from '@server/backup/export.js';
import { extractArchive, readManifest } from '@server/backup/extract.js';
import { prepareDatabase } from '@server/backup/import.js';
import { BackupStore } from '@server/backup/store.js';
import { runBackupWorker } from '@server/backup/run-worker.js';
import { BackupService } from '@server/backup/service.js';
import { nextBackupRun } from '@server/backup/schedule.js';
import { prepareUpgradeBackup, recordStartedVersion } from '@server/backup/upgrade.js';
import { stageRestore, resumeRestore } from '@server/backup/restore.js';
import { readMigrationJournal } from '@server/db/migrations.js';
import { assetRoots, BACKUP_TABLES } from '@server/backup/format.js';
import { backupFilename, UPGRADE_BACKUP_RETENTION, channelCreateSchema, scheduleTemplateCreateSchema, managedChannelLogoUri } from '@moirai/shared';

const roots: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});
async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'moirai-backup-test-'));
	roots.push(root);
	const config = loadConfig({ dataDir: path.join(root, 'data'), backupDir: path.join(root, 'backups'), migrationsDir: path.resolve('drizzle'), ffprobePath: path.resolve('tests/fixtures/fake-ffprobe.mjs') });
	const database = createDatabase(config.databasePath, config.migrationsDir);
	const repository = new Repository(database.db);
	const library = await repository.createLibrary({ name: 'Movies', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: '/missing', playbackRoot: '/media' }, scanIntervalMinutes: 15, watcherEnabled: false, enabled: false });
	const scanId = await repository.beginScan(library.id, 'manual');
	const mediaId = randomUUID();
	database.sqlite.prepare('INSERT INTO media_items (id,library_id,stable_key,kind,title,sort_title,relative_path,playback_path,metadata_status,metadata,fingerprint,date_added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(mediaId, library.id, 'stable-movie', 'movie', 'Example Movie', 'example movie', 'movie.mp4', '/media/movie.mp4', 'complete', '{}', 'fingerprint', new Date().toISOString());
	database.sqlite.prepare('INSERT INTO media_removal_tombstones(item_id,library_id,source_identity_hash,first_missing_at,last_missing_at,consecutive_observations,last_scan_id) VALUES (?,?,?,?,?,?,?)').run(mediaId, library.id, 'identity-hash', '2026-01-01', '2026-01-02', 2, scanId.id);
	const channel = await repository.createChannel(channelCreateSchema.parse({ name: 'Test channel', number: '1' }));
	const logo = channel.id;
	await repository.updateChannelLogo(channel, managedChannelLogoUri(channel.id));
	database.sqlite.prepare('INSERT INTO media_tail_assessments(library_id,relative_path,fingerprint,result,accepted) VALUES (?,?,?,?,?)').run(library.id, 'movie.mp4', 'fingerprint', 'not-black', 1);
	await mkdir(config.channelLogoDir, { recursive: true });
	await mkdir(path.join(config.dataDir, 'guide-artwork'), { recursive: true });
	const image = await sharp({ create: { width: 12, height: 12, channels: 4, background: 'red' } }).png().toBuffer();
	await writeFile(path.join(config.channelLogoDir, `${logo}.png`), image);
	await writeFile(path.join(config.dataDir, 'guide-artwork', `${randomUUID()}.png`), image);
	await mkdir(config.artworkCacheDir, { recursive: true });
	await writeFile(path.join(config.artworkCacheDir, 'thumbnail-secret'), 'regenerated');
	await writeFile(path.join(config.dataDir, 'ai-settings.json'), JSON.stringify({ version: 1, activeProvider: 'openai', profiles: { openai: { apiKey: 'SECRET_AI_KEY', verification: 'verified', modelOverride: null, webSearch: false } } }));
	database.sqlite.prepare('INSERT INTO authentication_initialization (id,method,initialized_at) VALUES (1,?,?)').run('local', '2026-01-01');
	database.sqlite.prepare("INSERT INTO authentication_identities (id,provider,display_name,username,username_key,password_hash) VALUES ('admin','local','Admin','admin','admin','SECRET_PASSWORD_HASH')").run();
	return { root, config, database, repository, library, mediaId, channel, logo, image };
}
async function exportFixture(value: Awaited<ReturnType<typeof fixture>>, kind: 'manual' | 'automatic' | 'upgrade' | 'pre-restore' = 'manual') {
	const store = new BackupStore(value.config.backupDir);
	const staging = await store.staging();
	try {
		return await createArchive(value.config, store.directory, staging, kind, '0.6.2');
	}
	finally {
		await store.cleanup(staging);
	}
}

it('reports validation stages from the worker in processing order', async () => {
	const value = await fixture();
	try {
		const backup = await exportFixture(value);
		const stages: string[] = [];
		await runBackupWorker(
			{ action: 'validate', config: value.config,
				filename: path.join(value.config.backupDir, backupFilename(backup)), staging: path.join(value.root, 'review') },
			undefined,
			stage => stages.push(stage),
		);
		expect(stages).toHaveLength(4);
		expect(stages[0]).toMatch(/archive integrity.*1\/4/);
		expect(stages[1]).toMatch(/database.*2\/4/);
		expect(stages[2]).toMatch(/configuration.*3\/4/);
		expect(stages[3]).toMatch(/assets.*4\/4/);
	}
	finally {
		value.database.sqlite.close();
	}
});

it('round-trips stable catalog identities, managed images, and settings without credentials or regenerated data', async () => {
	const value = await fixture();
	try {
		await value.repository.setBackupSettings({ enabled: true, intervalDays: 2, retention: 4 });
		await value.repository.setPlaybackSettings({ ...await value.repository.getPlaybackSettings(),
			audioPreferences: { language: 'fr', title: 'Original' } });
		const backup = await exportFixture(value);
		const manifest = await readManifest(path.join(value.config.backupDir, backupFilename(backup)));
		expect(manifest.tables).toEqual(expect.arrayContaining(['libraries', 'media_items', 'settings']));
		expect(manifest.tables.every(table => BACKUP_TABLES.includes(table))).toBe(true);
		expect(manifest.entries.some(entry => /authentication|thumbnail|embedding|materialized|scan_runs/.test(entry.name))).toBe(false);
		const staging = path.join(value.root, 'import');
		const imported = await extractArchive(path.join(value.config.backupDir, backupFilename(backup)), staging);
		const ai = JSON.parse(await readFile(path.join(staging, 'ai-settings.json'), 'utf8'));
		expect(ai.profiles.openai.apiKey).toBe('');
		expect(ai.profiles.openai.verification).toBe('unverified');
		expect(await readFile(path.join(staging, 'channel-logos', `${value.logo}.png`))).toEqual(value.image);
		await prepareDatabase(value.config, staging, imported);
		const restored = new Database(path.join(staging, 'restored.sqlite'));
		try {
			expect(restored.prepare('SELECT last_scan_id,consecutive_observations FROM media_removal_tombstones').get()).toEqual({ last_scan_id: null, consecutive_observations: 2 });
			expect(restored.prepare('SELECT accepted FROM media_tail_assessments').get()).toEqual({ accepted: 1 });
			expect(JSON.parse((restored.prepare("SELECT value FROM settings WHERE key='playback'").get() as { value: string }).value).audioPreferences)
				.toEqual({ language: 'fr', title: 'Original' });
			expect(restored.prepare('SELECT id FROM libraries').get()).toEqual({ id: value.library.id });
			expect(restored.prepare('SELECT id,library_id FROM media_items').get()).toEqual({ id: value.mediaId, library_id: value.library.id });
			expect(restored.prepare("SELECT entity_id FROM catalog_search WHERE catalog_search MATCH 'Example'").get()).toEqual({ entity_id: value.mediaId });
			expect(restored.prepare('SELECT COUNT(*) AS count FROM authentication_identities').get()).toEqual({ count: 0 });
			expect(JSON.parse((restored.prepare("SELECT value FROM settings WHERE key='backups'").get() as { value: string }).value).retention).toBe(4);
		}
		finally {
			restored.close();
		}
		const tables = (await readdir(path.join(staging, 'tables')));
		for (const table of tables) {
			expect(await readFile(path.join(staging, 'tables', table), 'utf8')).not.toContain('SECRET_');
		}
	}
	finally {
		value.database.close();
	}
});

it('runs export in a worker and prunes upgrade recovery independently from manual and restore recovery', async () => {
	const value = await fixture();
	const store = new BackupStore(value.config.backupDir);
	try {
		const manual = await exportFixture(value, 'manual');
		const recovery = await exportFixture(value, 'pre-restore');
		const upgrades = [];
		for (let index = 0; index <= UPGRADE_BACKUP_RETENTION; index += 1) {
			const staging = await store.staging();
			upgrades.push(await runBackupWorker<{ id: string }>({ action: 'create', config: value.config, directory: store.directory, staging, kind: 'upgrade', version: '0.6.2' }));
			await store.cleanup(staging);
		}
		await store.prune('upgrade', UPGRADE_BACKUP_RETENTION);
		const saved = await store.list();
		expect(saved.filter(entry => entry.kind === 'upgrade')).toHaveLength(UPGRADE_BACKUP_RETENTION);
		expect(saved.map(entry => entry.id)).not.toContain(upgrades[0]!.id);
		expect(saved.map(entry => entry.id)).toEqual(expect.arrayContaining([manual.id, recovery.id]));
	}
	finally {
		value.database.close();
	}
}, 30_000);

it('restores through the durable journal and preserves destination administrator identity while clearing sessions', async () => {
	const value = await fixture();
	const staging = path.join(value.config.dataDir, 'restore-staging', 'review-test');
	try {
		const backup = await exportFixture(value);
		const manifest = await extractArchive(path.join(value.config.backupDir, backupFilename(backup)), staging);
		await prepareDatabase(value.config, staging, manifest);
		value.database.sqlite.prepare("UPDATE authentication_identities SET password_hash='DESTINATION_PASSWORD'").run();
		value.database.sqlite.prepare("UPDATE libraries SET name='Changed'").run();
		value.database.sqlite.prepare("INSERT INTO authentication_sessions(token_hash,identity_id,csrf_token,created_at,last_seen_at,expires_at) VALUES ('session','admin','csrf','2026-01-01','2026-01-01','2099-01-01')").run();
		const generatedRoots = [value.config.artworkCacheDir, value.config.playbackStreamDir, value.config.playbackPlayoutDir];
		const rootInodes = [];
		for (const directory of generatedRoots) {
			await mkdir(path.join(directory, 'nested'), { recursive: true });
			await writeFile(path.join(directory, 'nested', 'stale'), 'generated output');
			rootInodes.push((await stat(directory)).ino);
		}
		value.database.close();
		await stageRestore(value.config, staging);
		expect(await resumeRestore(value.config)).toBe(true);
		expect(await resumeRestore(value.config)).toBe(false);
		for (const [index, directory] of generatedRoots.entries()) {
			expect((await stat(directory)).ino).toBe(rootInodes[index]);
			expect(await readdir(directory)).toEqual([]);
		}
		const restored = createDatabase(value.config.databasePath, value.config.migrationsDir);
		try {
			expect(restored.sqlite.prepare('SELECT name FROM libraries').get()).toEqual({ name: 'Movies' });
			expect(restored.sqlite.prepare('SELECT password_hash FROM authentication_identities').get()).toEqual({ password_hash: 'DESTINATION_PASSWORD' });
			expect(restored.sqlite.prepare('SELECT count(*) AS count FROM authentication_sessions').get()).toEqual({ count: 0 });
			expect(await stat(path.join(value.config.artworkCacheDir, 'thumbnail-secret')).catch(() => null)).toBe(null);
			expect((await new BackupStore(value.config.backupDir).list()).map(entry => entry.id)).toContain(backup.id);
		}
		finally {
			restored.close();
		}
	}
	finally {
		if (value.database.sqlite.open) {
			value.database.close();
		}
	}
});

it('restores managed asset contents while preserving each directory root and clearing legacy temporary copies', async () => {
	const value = await fixture();
	const staging = path.join(value.config.dataDir, 'restore-staging', 'review-mounted-assets');
	try {
		const backup = await exportFixture(value);
		const manifest = await extractArchive(path.join(value.config.backupDir, backupFilename(backup)), staging);
		await prepareDatabase(value.config, staging, manifest);
		const expected = [];
		for (const [namespace, directory] of Object.entries(assetRoots(value.config))) {
			const source = path.join(staging, namespace);
			const names = await readdir(source).catch(() => [] as string[]);
			const files = await Promise.all(names.map(async name => ({ name, bytes: await readFile(path.join(source, name)) })));
			await mkdir(path.join(directory, 'nested'), { recursive: true });
			await writeFile(path.join(directory, 'nested', 'stale'), 'remove this old asset');
			for (const file of files) {
				await writeFile(path.join(directory, file.name), 'replace this changed asset');
			}
			await mkdir(`${directory}.restore-tmp`, { recursive: true });
			await writeFile(path.join(`${directory}.restore-tmp`, 'partial'), 'interrupted earlier restore');
			expected.push({ directory, inode: (await stat(directory)).ino, files });
		}
		value.database.close();
		await stageRestore(value.config, staging);
		expect(await resumeRestore(value.config)).toBe(true);
		for (const { directory, inode, files } of expected) {
			expect((await stat(directory)).ino).toBe(inode);
			expect((await readdir(directory)).sort()).toEqual(files.map(file => file.name).sort());
			for (const file of files) {
				expect(await readFile(path.join(directory, file.name))).toEqual(file.bytes);
			}
			expect(await stat(`${directory}.restore-tmp`).catch(() => null)).toBe(null);
		}
		expect(await resumeRestore(value.config)).toBe(false);
	}
	finally {
		if (value.database.sqlite.open) {
			value.database.close();
		}
	}
});

describe('calendar scheduling', () => {
	it('anchors to 3am, advances calendar intervals, and skips missed slots', () => {
		expect(nextBackupRun('2026-10-17T08:00:00Z', 'America/Los_Angeles')).toBe('2026-10-17T10:00:00Z');
		expect(nextBackupRun('2026-10-17T10:00:00Z', 'America/Los_Angeles')).toBe('2026-10-18T10:00:00Z');
		expect(nextBackupRun('2026-10-24T12:00:00Z', 'America/Los_Angeles', 2, '2026-10-17T10:00:00Z')).toBe('2026-10-25T10:00:00Z');
	});
	it('keeps local 3am across daylight saving changes', () => {
		expect(nextBackupRun('2026-03-08T08:00:00Z', 'America/Los_Angeles')).toBe('2026-03-08T10:00:00Z');
		expect(nextBackupRun('2026-11-01T07:00:00Z', 'America/Los_Angeles')).toBe('2026-11-01T11:00:00Z');
		expect(nextBackupRun('2026-09-26T12:00:00Z', 'Pacific/Chatham')).toBe('2026-09-26T14:00:00Z');
		expect(nextBackupRun('2026-10-24T22:00:00Z', 'Europe/Helsinki')).toBe('2026-10-25T00:00:00Z');
	});
});

it('rejects unknown archive members before extracting them', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'moirai-unsafe-'));
	roots.push(root);
	const filename = path.join(root, 'bad.zip');
	const zip = new yazl.ZipFile();
	const output = pipeline(zip.outputStream, createWriteStream(filename));
	zip.addBuffer(Buffer.from('secret'), 'authentication.json');
	zip.end();
	await output;
	await expect(extractArchive(filename, path.join(root, 'extract'))).rejects.toThrow('unsafe');
});

it('captures the existing prior schema before migrations and restores it through real migrations', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'moirai-prior-backup-'));
	roots.push(root);
	const migrations = path.join(root, 'migrations');
	await cp(path.resolve('drizzle'), migrations, { recursive: true });
	const journalFile = path.join(migrations, 'meta', '_journal.json');
	const journal = JSON.parse(await readFile(journalFile, 'utf8'));
	journal.entries = journal.entries.slice(0, -1);
	await writeFile(journalFile, JSON.stringify(journal));
	const config = loadConfig({ dataDir: path.join(root, 'data'), backupDir: path.join(root, 'backups'), migrationsDir: migrations });
	const old = createDatabase(config.databasePath, migrations);
	old.sqlite.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('playback', JSON.stringify({ maxActiveSessions: 9, viewingPreferencesEnabled: true }));
	old.close();
	config.migrationsDir = path.resolve('drizzle');
	await prepareUpgradeBackup(config);
	const store = new BackupStore(config.backupDir);
	const saved = await store.list();
	expect(saved).toHaveLength(1);
	expect(saved[0]!.kind).toBe('upgrade');
	const prior = new Database(config.databasePath);
	expect((prior.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get() as { count: number }).count).toBe(journal.entries.length);
	prior.close();
	const staging = path.join(root, 'restoring');
	const manifest = await extractArchive(await store.filename(saved[0]!.id), staging);
	await prepareDatabase(config, staging, manifest);
	const upgraded = createDatabase(path.join(staging, 'restored.sqlite'), config.migrationsDir);
	try {
		expect(await new Repository(upgraded.db).getPlaybackSettings()).toMatchObject({ maxActiveSessions: 9, audioPreferences: {} });
	}
	finally {
		upgraded.close();
	}
}, 30_000);

it('continues upgrade preparation with a persistent warning if the backup directory is unavailable', async () => {
	const value = await fixture();
	try {
		await writeFile(value.config.backupDir, 'not a directory');
		await expect(prepareUpgradeBackup(value.config)).resolves.toBeUndefined();
		expect(JSON.parse(await readFile(path.join(value.config.dataDir, 'backup-warning.json'), 'utf8')).message).toContain('Startup will continue');
		const upgraded = createDatabase(value.config.databasePath, value.config.migrationsDir);
		upgraded.close();
	}
	finally {
		value.database.close();
	}
});

it('loads defaults, saves policy through the repository, and does not create a catch-up backup on startup', async () => {
	const value = await fixture();
	const service = new BackupService(value.config, value.repository);
	try {
		await writeFile(path.join(value.config.dataDir, 'backup-schedule.json'), JSON.stringify({ nextRun: '2020-01-01T03:00:00Z' }));
		await service.start();
		expect((await service.status()).settings).toEqual({ enabled: true, intervalDays: 1, retention: 7 });
		expect((await service.status()).backups).toHaveLength(0);
		expect(Date.parse((await service.status()).nextRun!)).toBeGreaterThan(Date.now());
		await service.saveSettings({ enabled: false, intervalDays: 3, retention: 2 });
		expect(await value.repository.getBackupSettings()).toEqual({ enabled: false, intervalDays: 3, retention: 2 });
		await recordStartedVersion(value.config);
		await prepareUpgradeBackup(value.config);
		expect((await service.status()).backups).toHaveLength(0);
	}
	finally {
		await service.close();
		value.database.close();
	}
});


it('includes global and channel fallback uploads and validates their saved stream metadata', async () => {
	const value = await fixture();
	try {
		const asset = Buffer.from('fixture video');
		for (const scope of ['global', `channels/${value.channel.id}`]) {
			const root = path.join(value.config.fallbackFillerDir, scope, 'current');
			await mkdir(root, { recursive: true });
			await writeFile(path.join(root, 'asset'), asset);
			await writeFile(path.join(root, 'metadata.json'), JSON.stringify({ version: 1, filename: 'fallback.mp4', contentType: 'video/mp4', fileSizeBytes: asset.length,
				durationMilliseconds: 5880125, resolution: { width: 1920, height: 1080 }, hasAudio: true, videoStreamIndex: 0, updatedAt: null }));
		}
		const backup = await exportFixture(value);
		const staging = path.join(value.root, 'fallback-import');
		const manifest = await extractArchive(path.join(value.config.backupDir, backupFilename(backup)), staging);
		expect(manifest.entries.filter(entry => entry.name.endsWith('/asset'))).toHaveLength(2);
		await prepareDatabase(value.config, staging, manifest);
		expect(await readFile(path.join(staging, 'fallback-fillers', 'channels', value.channel.id, 'current', 'asset'))).toEqual(asset);
	}
	finally {
		value.database.close();
	}
});

it('rejects concurrent operations and requires a successful recovery archive before restore intent is committed', async () => {
	const value = await fixture();
	const service = new BackupService(value.config, value.repository);
	try {
		await service.start();
		const creating = service.create();
		await expect(service.create()).rejects.toMatchObject({ statusCode: 409 });
		const backup = await creating;
		const preview = await service.reviewUpload(async destination => cp(await service.store.filename(backup.id), destination));
		await rename(value.config.backupDir, `${value.config.backupDir}-offline`);
		await writeFile(value.config.backupDir, 'volume missing');
		await expect(service.restore(preview.id)).rejects.toThrow();
		expect(await stat(path.join(value.config.dataDir, 'restore-journal.json')).catch(() => null)).toBe(null);
		expect(await value.repository.getLibrary(value.library.id)).toMatchObject({ name: 'Movies' });
	}
	finally {
		await service.close();
		value.database.close();
	}
}, 30_000);

it('prunes excess upgrade backups at startup even when automatic backups are disabled', async () => {
	const value = await fixture();
	const service = new BackupService(value.config, value.repository);
	try {
		const manual = await exportFixture(value);
		for (let index = 0; index <= UPGRADE_BACKUP_RETENTION; index += 1) {
			await exportFixture(value, 'upgrade');
		}
		await value.repository.setBackupSettings({ enabled: false, intervalDays: 1, retention: 7 });
		await service.start();
		const saved = (await service.status()).backups;
		expect(saved.filter(backup => backup.kind === 'upgrade')).toHaveLength(UPGRADE_BACKUP_RETENTION);
		expect(saved.map(backup => backup.id)).toContain(manual.id);
	}
	finally {
		await service.close();
		value.database.close();
	}
});


it('creates scheduled backups at 3am and applies automatic retention without pruning manual backups', async () => {
	const value = await fixture();
	value.config.timeZone = 'UTC';
	const service = new BackupService(value.config, value.repository);
	try {
		const manual = await exportFixture(value);
		await exportFixture(value, 'automatic');
		await value.repository.setBackupSettings({ enabled: true, intervalDays: 1, retention: 1 });
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
		vi.setSystemTime(new Date('2026-10-17T02:59:59Z'));
		await service.start();
		await vi.advanceTimersByTimeAsync(1001);
		await vi.waitFor(async () => {
			const status = await service.status();
			expect(status.busy).toBe(null);
			expect(status.nextRun).toBe('2026-10-18T03:00:00Z');
		}, { timeout: 20_000 });
		const saved = (await service.status()).backups;
		expect(saved.filter(backup => backup.kind === 'automatic')).toHaveLength(1);
		expect(saved.map(backup => backup.id)).toContain(manual.id);
	}
	finally {
		await service.close();
		value.database.close();
	}
}, 30_000);

it('skips a failed automatic slot and clears its warning after the next successful run', async () => {
	const value = await fixture();
	value.config.timeZone = 'UTC';
	const service = new BackupService(value.config, value.repository);
	try {
		const existing = await exportFixture(value, 'automatic');
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
		vi.setSystemTime(new Date('2026-10-17T02:59:59Z'));
		await service.start();
		await rename(value.config.backupDir, `${value.config.backupDir}-offline`);
		await writeFile(value.config.backupDir, 'volume missing');
		await vi.advanceTimersByTimeAsync(1001);
		await vi.waitFor(async () => {
			expect(JSON.parse(await readFile(path.join(value.config.dataDir, 'backup-warning.json'), 'utf8')).message).toContain('scheduled backup');
		});
		await rm(value.config.backupDir);
		await rename(`${value.config.backupDir}-offline`, value.config.backupDir);
		await vi.advanceTimersByTimeAsync(60_000);
		const status = await service.status();
		expect(status.nextRun).toBe('2026-10-18T03:00:00Z');
		expect(status.backups.map(backup => backup.id)).toEqual([existing.id]);
		expect(status.error).toBeTruthy();
		vi.setSystemTime(new Date('2026-10-18T02:59:00Z'));
		await vi.advanceTimersByTimeAsync(60_001);
		await vi.waitFor(async () => {
			const next = await service.status();
			expect(next.busy).toBe(null);
			expect(next.error).toBe(null);
			expect(next.backups).toHaveLength(2);
		}, { timeout: 20_000 });
		expect(await stat(path.join(value.config.dataDir, 'backup-warning.json')).catch(() => null)).toBe(null);

	}
	finally {
		await service.close();
		value.database.close();
	}
}, 30_000);


it('resumes a restore after assets changed but database replacement was interrupted', async () => {
	const value = await fixture();
	const staging = path.join(value.config.dataDir, 'restore-staging', 'review-interrupted');
	try {
		const backup = await exportFixture(value);
		const manifest = await extractArchive(path.join(value.config.backupDir, backupFilename(backup)), staging);
		await prepareDatabase(value.config, staging, manifest);
		value.database.sqlite.prepare("UPDATE libraries SET name='Before interrupted restore'").run();
		value.database.close();
		await stageRestore(value.config, staging);
		await mkdir(`${value.config.databasePath}.restore-tmp`);
		await expect(resumeRestore(value.config)).rejects.toThrow();
		expect(JSON.parse(await readFile(path.join(value.config.dataDir, 'restore-journal.json'), 'utf8')).authenticationCaptured).toBe(true);
		await rm(`${value.config.databasePath}.restore-tmp`, { recursive: true });
		expect(await resumeRestore(value.config)).toBe(true);
		const restored = createDatabase(value.config.databasePath, value.config.migrationsDir);
		try {
			expect(restored.sqlite.prepare('SELECT name FROM libraries').get()).toEqual({ name: 'Movies' });
			expect(restored.sqlite.prepare('SELECT password_hash FROM authentication_identities').get()).toEqual({ password_hash: 'SECRET_PASSWORD_HASH' });
		}
		finally {
			restored.close();
		}
	}
	finally {
		if (value.database.sqlite.open) {
			value.database.close();
		}
	}
});


it.each([
	['schedule_templates', 'period', 'day', true],
	['schedule_templates', 'default_filler', 'not json', false],
	['schedule_templates', 'default_mid_roll', '{"programId":"invalid"}', false],
	['schedule_slots', 'start_eligibility', 'not json', false],
	['schedule_slots', 'filler', '{"mode":"invalid"}', false],
	['schedule_slots', 'guide', '{"mode":"invalid"}', false],
	['schedule_boundaries', 'policy', 'invalid', false],
])('validates restored %s.%s = %s before accepting a preview', async (table, column, value, valid) => {
	const installation = await fixture();
	try {
		const slotId = randomUUID();
		await installation.repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({
			name: 'Daily', slots: [{ id: slotId, startSeconds: 0, programId: null, filler: { mode: 'disabled' } }],
			boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: 86400 }],
		}));
		installation.database.sqlite.prepare(`UPDATE "${table}" SET "${column}" = ?`).run(value);
		const backup = await exportFixture(installation);
		const staging = path.join(installation.root, 'invalid-schedule');
		const manifest = await extractArchive(path.join(installation.config.backupDir, backupFilename(backup)), staging);
		const prepared = prepareDatabase(installation.config, staging, manifest);
		if (valid) {
			await expect(prepared).resolves.toMatchObject({ libraries: 1, channels: 1, mediaItems: 1 });
		}
		else {
			await expect(prepared).rejects.toMatchObject({ code: 'backup_invalid_records' });
		}
	}
	finally {
		installation.database.close();
	}
});

it.each([
	['UTC', '2026-10-18T03:00:00Z', '2026-10-17T10:00:00Z'],
	['America/Los_Angeles', '2026-10-19T10:00:00Z', '2026-10-19T10:00:00Z'],
	[undefined, '2026-10-18T03:00:00Z', '2026-10-17T10:00:00Z'],
])('reconciles a persisted schedule from timezone %s', async (timeZone, nextRun, expected) => {
	const value = await fixture();
	value.config.timeZone = 'America/Los_Angeles';
	const service = new BackupService(value.config, value.repository);
	try {
		await writeFile(path.join(value.config.dataDir, 'backup-schedule.json'), JSON.stringify({ timeZone, nextRun }));
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
		vi.setSystemTime(new Date('2026-10-17T08:00:00Z'));
		await service.start();
		expect((await service.status()).nextRun).toBe(expected);
		expect(JSON.parse(await readFile(path.join(value.config.dataDir, 'backup-schedule.json'), 'utf8'))).toEqual({
			nextRun: expected, timeZone: value.config.timeZone,
		});
	}
	finally {
		await service.close();
		value.database.close();
	}
});


it('keeps automatic backups scheduled when storage is unavailable at startup', async () => {
	const value = await fixture();
	value.config.timeZone = 'UTC';
	const service = new BackupService(value.config, value.repository);
	try {
		await writeFile(value.config.backupDir, 'volume unavailable');
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
		vi.setSystemTime(new Date('2026-10-17T02:59:59Z'));
		await service.start();
		await rm(value.config.backupDir);
		const recovered = await service.status();
		expect(recovered.error).toContain('already exists');
		expect(JSON.parse(await readFile(path.join(value.config.dataDir, 'backup-warning.json'), 'utf8')).message).toContain('already exists');
		expect(recovered.nextRun).toBe('2026-10-17T03:00:00Z');
		await vi.advanceTimersByTimeAsync(1001);
		await vi.waitFor(async () => {
			const status = await service.status();
			expect(status.busy).toBe(null);
			expect(status.backups).toHaveLength(1);
			expect(status.backups[0]!.kind).toBe('automatic');
			expect(status.nextRun).toBe('2026-10-18T03:00:00Z');
		}, { timeout: 20_000 });
	}
	finally {
		await service.close();
		value.database.close();
	}
}, 30_000);


it('preserves storage error codes from archive workers for actionable public diagnostics', async () => {
	const value = await fixture();
	try {
		await writeFile(path.join(value.root, 'worker-staging'), 'not a directory');
		await expect(runBackupWorker({ action: 'create', config: value.config,
			staging: path.join(value.root, 'worker-staging'), directory: value.config.backupDir, kind: 'manual', version: '0.6.2',
		})).rejects.toMatchObject({ code: 'ENOTDIR' });
	}
	finally {
		value.database.close();
	}
});

it('stores timestamped archives and keeps legacy identity-only backups usable', async () => {
	const value = await fixture();
	const store = new BackupStore(value.config.backupDir);
	try {
		const backup = await exportFixture(value);
		const timestamped = await store.filename(backup.id);
		expect(path.basename(timestamped)).toBe(backupFilename(backup));
		expect(path.basename(timestamped)).toContain(new Date(backup.createdAt).toISOString().replaceAll(':', '-'));
		const legacy = path.join(value.config.backupDir, `${backup.id}.zip`);
		await rename(timestamped, legacy);
		expect(await store.filename(backup.id)).toBe(legacy);
		expect(await store.list()).toEqual([backup]);
		const staging = path.join(value.root, 'legacy-import');
		const manifest = await extractArchive(await store.filename(backup.id), staging);
		await expect(prepareDatabase(value.config, staging, manifest)).resolves.toMatchObject({ libraries: 1, mediaItems: 1 });
		await store.delete(backup.id);
		expect(await store.list()).toEqual([]);
	}
	finally {
		value.database.close();
	}
});


it('clears a legacy upgrade warning after the next successful upgrade recovery backup', async () => {
	const value = await fixture();
	try {
		const filename = path.join(value.config.dataDir, 'backup-warning.json');
		await writeFile(filename, JSON.stringify({ message: 'Upgrade recovery backup or cleanup failed.' }));
		await recordStartedVersion(value.config);
		await prepareUpgradeBackup(value.config);
		expect(await stat(filename)).toBeTruthy();
		await rm(path.join(value.config.dataDir, 'last-started-version.json'));
		await prepareUpgradeBackup(value.config);
		expect((await new BackupStore(value.config.backupDir).list()).filter(backup => backup.kind === 'upgrade')).toHaveLength(1);
		expect(await stat(filename).catch(() => null)).toBe(null);
	}
	finally {
		value.database.close();
	}
}, 30_000);

it('persists warning dismissal and shows a later failure again', async () => {
	const value = await fixture();
	let service = new BackupService(value.config, value.repository);
	try {
		const filename = path.join(value.config.dataDir, 'backup-warning.json');
		await writeFile(filename, JSON.stringify({ message: 'Upgrade recovery failed.' }));
		await service.start();
		await service.saveSettings({ enabled: false, intervalDays: 1, retention: 7 });
		expect((await service.status()).error).toBe('Upgrade recovery failed.');
		await service.dismissWarning();
		expect((await service.status()).error).toBe(null);
		await service.close();
		service = new BackupService(value.config, value.repository);
		await service.start();
		expect((await service.status()).error).toBe(null);
		vi.spyOn(service.store, 'prune').mockRejectedValueOnce(new Error('Cleanup failed'));
		await service.saveSettings({ enabled: false, intervalDays: 1, retention: 7 });
		expect((await service.status()).error).toContain('cleanup failed');
		await service.saveSettings({ enabled: false, intervalDays: 1, retention: 7 });
		expect((await service.status()).error).toBe(null);
		expect(await stat(filename).catch(() => null)).toBe(null);
	}
	finally {
		await service.close();
		value.database.close();
	}
});

it('clears upgrade cleanup warnings when startup retention succeeds', async () => {
	const value = await fixture();
	try {
		const filename = path.join(value.config.dataDir, 'backup-warning.json');
		await writeFile(filename, JSON.stringify({ message: 'Upgrade recovery cleanup failed.', kind: 'upgrade-cleanup' }));
		await recordStartedVersion(value.config);
		await prepareUpgradeBackup(value.config);
		expect(await stat(filename).catch(() => null)).toBe(null);
	}
	finally {
		value.database.close();
	}
});


it('restores automatic archives with obsolete markers, historical hashes, and identical duplicates', async () => {
	const value = await fixture();
	const service = new BackupService(value.config, value.repository);
	try {
		const journal = readMigrationJournal(value.config.migrationsDir);
		value.database.sqlite.prepare("UPDATE __drizzle_migrations SET hash='historical-sql'").run();
		for (let index = 1; index <= 4; index += 1) {
			value.database.sqlite.prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)').run('retired', journal[0]!.when + index);
		}
		value.database.sqlite.prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)').run('historical-sql', journal[0]!.when);
		const backup = await exportFixture(value, 'automatic');
		await service.start();
		const preview = await service.reviewUpload(async destination => cp(await service.store.filename(backup.id), destination));
		expect(preview).toMatchObject({ libraries: 1, channels: 1, mediaItems: 1, backup: { kind: 'automatic', id: backup.id } });
		expect(await value.repository.getLibrary(value.library.id)).toMatchObject({ name: 'Movies' });
	}
	finally {
		await service.close();
		value.database.close();
	}
}, 30_000);

it.each(['future', 'gap', 'conflicting-duplicate', 'empty'])('rejects %s migration history without changing live data', async kind => {
	const value = await fixture();
	const service = new BackupService(value.config, value.repository);
	try {
		const journal = readMigrationJournal(value.config.migrationsDir);
		if (kind === 'future') {
			value.database.sqlite.prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)').run('future', journal.at(-1)!.when + 1);
		}
		else if (kind === 'gap') {
			value.database.sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at=?').run(journal[1]!.when);
		}
		else if (kind === 'conflicting-duplicate') {
			value.database.sqlite.prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)').run('different', journal[0]!.when);
		}
		else {
			value.database.sqlite.exec('DELETE FROM __drizzle_migrations');
		}
		const backup = await exportFixture(value);
		await service.start();
		await expect(service.reviewUpload(async destination => cp(await service.store.filename(backup.id), destination)))
			.rejects.toMatchObject({ code: 'backup_unsupported_schema', statusCode: 422 });
		expect(await value.repository.getLibrary(value.library.id)).toMatchObject({ name: 'Movies' });
		expect(await stat(path.join(value.config.dataDir, 'restore-journal.json')).catch(() => null)).toBe(null);
		expect(await readdir(path.join(value.config.dataDir, 'restore-staging'))).toEqual([]);
	}
	finally {
		await service.close();
		value.database.close();
	}
}, 30_000);

it('rejects record-column mismatches through a typed worker failure', async () => {
	const value = await fixture();
	const service = new BackupService(value.config, value.repository);
	try {
		value.database.sqlite.exec('ALTER TABLE libraries ADD COLUMN unsupported TEXT');
		const backup = await exportFixture(value);
		await service.start();
		await expect(service.reviewUpload(async destination => cp(await service.store.filename(backup.id), destination)))
			.rejects.toMatchObject({ code: 'backup_invalid_records', statusCode: 422 });
	}
	finally {
		await service.close();
		value.database.close();
	}
}, 30_000);

it('classifies fallback validation failures without exposing metadata content', async () => {
	const value = await fixture();
	const service = new BackupService(value.config, value.repository);
	try {
		const root = path.join(value.config.fallbackFillerDir, 'global', 'current');
		await mkdir(root, { recursive: true });
		await writeFile(path.join(root, 'asset'), 'fixture video');
		await writeFile(path.join(root, 'metadata.json'), '{}');
		const backup = await exportFixture(value);
		await service.start();
		await expect(service.reviewUpload(async destination => cp(await service.store.filename(backup.id), destination)))
			.rejects.toMatchObject({ code: 'backup_invalid_assets', statusCode: 422 });
	}
	finally {
		await service.close();
		value.database.close();
	}
}, 30_000);


it('isolates damaged archives while retaining healthy recovery points and deletion by identity', async () => {
	const value = await fixture();
	try {
		const backup = await exportFixture(value, 'automatic');
		const damagedId = randomUUID();
		await writeFile(path.join(value.config.backupDir, `${damagedId}.zip`), 'truncated ZIP');
		const store = new BackupStore(value.config.backupDir);
		expect(await store.inventory()).toEqual({
			backups: [backup], damagedBackups: [{ id: damagedId, name: `${damagedId}.zip` }],
		});
		expect((await readManifest(await store.filename(backup.id))).id).toBe(backup.id);
		await store.prune('automatic', 1);
		expect(await store.list()).toEqual([backup]);
		expect((await store.inventory()).damagedBackups).toHaveLength(1);
		const service = new BackupService(value.config, value.repository);
		expect((await service.status()).damagedBackups).toEqual([{ id: damagedId, name: `${damagedId}.zip` }]);
		await service.delete(damagedId);
		expect((await service.status()).damagedBackups).toEqual([]);
		expect(await store.list()).toEqual([backup]);
	}
	finally {
		value.database.close();
	}
});
