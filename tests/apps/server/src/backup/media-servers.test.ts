import { mkdtemp, rm, readFile, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { backupFilename, libraryCreateSchema, mediaServerCreateSchema } from '@moirai/shared';
import { loadConfig } from '@server/config.js';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { BackupStore } from '@server/backup/store.js';
import { createArchive } from '@server/backup/export.js';
import { extractArchive } from '@server/backup/extract.js';
import { prepareDatabase } from '@server/backup/import.js';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(priorSchema = false) {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-remote-backup-'));
	roots.push(root);
	const migrations = path.join(root, 'migrations');
	await cp(path.resolve('drizzle'), migrations, { recursive: true });
	if (priorSchema) {
		const filename = path.join(migrations, 'meta/_journal.json');
		const journal = JSON.parse(await readFile(filename, 'utf8'));
		journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag !== '0046_jellyfin_playback_reporting');
		await writeFile(filename, JSON.stringify(journal));
	}
	const config = loadConfig({ dataDir: path.join(root, 'data'), backupDir: path.join(root, 'backups'), migrationsDir: migrations });
	const database = createDatabase(config.databasePath, migrations);
	const repository = new Repository(database.db);
	return { root, config, database, repository };
}

async function archiveAndExtract(f: Awaited<ReturnType<typeof fixture>>) {
	const store = new BackupStore(f.config.backupDir);
	const capture = await store.staging();
	const archive = await createArchive(f.config, store.directory, capture, 'manual', '0.8.0');
	const staging = path.join(f.root, 'restored');
	const manifest = await extractArchive(path.join(store.directory, backupFilename(archive)), staging);
	return { staging, manifest };
}

it('round-trips all remote server definitions and accepted/pending library identities without tokens', async () => {
	const f = await fixture();
	try {
		const expected = [];
		for (const provider of ['plex', 'jellyfin', 'emby'] as const) {
			const server = await f.repository.mediaServers.createMediaServer(mediaServerCreateSchema.parse({
				provider, name: provider, baseUrl: `https://${provider}.example`, accessToken: `SECRET_${provider}_TOKEN`,
				pathReplacements: [{ remotePrefix: '/remote', localPrefix: '/mapped' }],
			}), { serverKey: provider, serverName: provider, libraries: [] });
			const sourceConfig = { mediaServerId: server.id, remoteLibraryId: '1', remoteLibraryName: 'Movies' };
			const library = await f.repository.createLibrary(libraryCreateSchema.parse({ name: provider, typeKey: 'movies', sourceType: provider, sourceConfig }));
			expected.push({ server, library });
		}
		const first = expected[0]!;
		await f.repository.stageLibrarySourceChange(first.library.id, {
			sourceType: 'jellyfin', sourceConfig: expected[1]!.library.sourceConfig,
		}, first.library);
		const { staging, manifest } = await archiveAndExtract(f);
		expect(manifest.tables).toContain('media_servers');
		expect(await readFile(path.join(staging, 'tables/media_servers.ndjson'), 'utf8')).not.toContain('SECRET_');
		await prepareDatabase(f.config, staging, manifest);
		const restored = createDatabase(path.join(staging, 'restored.sqlite'), f.config.migrationsDir);
		try {
			const repository = new Repository(restored.db);
			for (const { server, library } of expected) {
				expect(await repository.mediaServers.getMediaServer(server.id)).toMatchObject({
					id: server.id, provider: server.provider, baseUrl: server.baseUrl,
					pathReplacements: server.pathReplacements, hasCredential: false,
				});
				expect((await repository.getLibrary(library.id))!.sourceConfig).toEqual(library.sourceConfig);
			}
			expect((await repository.getLibraryScanTarget(first.library.id))!.sourceType).toBe('jellyfin');
		}
		finally {
			restored.close(); 
		}
	}
	finally {
		f.database.close(); 
	}
});

it('restores pre-reporting Plex rows through the real reporting migration', async () => {
	const f = await fixture(true);
	try {
		const id = randomUUID();
		f.database.sqlite.prepare(`INSERT INTO media_servers
			(id,provider,name,name_key,base_url,server_key,server_name,client_identifier,access_token)
			VALUES (?,?,?,?,?,?,?,?,?)`).run(id, 'plex', 'Plex', 'plex', 'https://plex.example', 'old-server', 'Plex', 'old-device-id', 'SECRET_OLD_TOKEN');
		await f.repository.createLibrary(libraryCreateSchema.parse({
			name: 'Old Plex', typeKey: 'movies', sourceType: 'plex',
			sourceConfig: { mediaServerId: id, remoteLibraryId: '1', remoteLibraryName: 'Movies' },
		}));
		const { staging, manifest } = await archiveAndExtract(f);
		f.config.migrationsDir = path.resolve('drizzle');
		await prepareDatabase(f.config, staging, manifest);
		const restored = new Database(path.join(staging, 'restored.sqlite'));
		try {
			expect(restored.prepare('SELECT access_token,playback_reporting_enabled FROM media_servers WHERE id=?').get(id))
				.toEqual({ access_token: '', playback_reporting_enabled: 0 });
			expect(manifest.migrations.length).toBeLessThan((restored.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get() as { count: number }).count);
		}
		finally {
			restored.close(); 
		}
	}
	finally {
		f.database.close(); 
	}
});

it.each(['missing', 'wrong-provider'] as const)('rejects a restored remote library with a %s connection', async reason => {
	const f = await fixture();
	try {
		const server = await f.repository.mediaServers.createMediaServer(mediaServerCreateSchema.parse({
			provider: 'jellyfin', name: 'Server', baseUrl: 'https://jellyfin.example', accessToken: 'SECRET_TOKEN',
		}), { serverKey: 'server', serverName: 'Server', libraries: [] });
		await f.repository.createLibrary(libraryCreateSchema.parse({
			name: 'Invalid source', typeKey: 'movies', sourceType: 'plex',
			sourceConfig: { mediaServerId: reason === 'missing' ? randomUUID() : server.id, remoteLibraryId: '1', remoteLibraryName: 'Movies' },
		}));
		const { staging, manifest } = await archiveAndExtract(f);
		await expect(prepareDatabase(f.config, staging, manifest)).rejects.toMatchObject({ code: 'backup_invalid_records' });
	}
	finally {
		f.database.close(); 
	}
});
