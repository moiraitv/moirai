import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createDatabase } from '@server/db/index.js';
import { runMigrationsInWorker } from '@server/db/migrations.js';
import { Repository } from '@server/repository/index.js';
import { ensurePrivateDirectory } from '@server/operations/private-storage.js';
import { loadMediaStreamSecret } from '@server/media-servers/secret.js';

async function mode(file: string): Promise<number> {
	return (await stat(file)).mode & 0o777;
}

it('hardens a permissive existing database and preserves credentials and schema markers', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-private-storage-'));
	const directory = path.join(root, 'data');
	const file = path.join(directory, 'moirai.sqlite');
	let database: ReturnType<typeof createDatabase> | undefined;
	try {
		const previousUmask = process.umask(0o022);
		try {
			database = createDatabase(file, path.resolve('drizzle'));
		}
		finally {
			process.umask(previousUmask);
		}
		const server = await new Repository(database!.db).mediaServers.createMediaServer({
			provider: 'plex', name: 'Audit', baseUrl: 'https://audit.test', accessToken: 'audit-storage-token', allowInsecureTls: false, playbackReportingEnabled: false, pathReplacements: [],
		}, { serverKey: 'audit', serverName: 'Audit', libraries: [] });
		const markers = database!.sqlite.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at').all();
		for (const artifact of [file, `${file}-wal`, `${file}-shm`]) {
			expect(await mode(artifact)).toBe(0o600);
			await chmod(artifact, 0o644);
		}
		await chmod(directory, 0o755);
		database!.close();
		database = undefined;

		ensurePrivateDirectory(directory);
		database = createDatabase(file, path.resolve('drizzle'));
		const connection = await new Repository(database.db).mediaServers.getMediaServerConnection(server.id);
		expect(connection?.accessToken).toBe('audit-storage-token');
		expect(database.sqlite.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at').all()).toEqual(markers);
		expect(await mode(directory)).toBe(0o700);
		for (const artifact of [file, `${file}-wal`, `${file}-shm`]) {
			expect(await mode(artifact)).toBe(0o600);
		}
		const secret = await loadMediaStreamSecret(directory);
		await chmod(path.join(directory, 'media-stream-secret'), 0o644);
		expect(await loadMediaStreamSecret(directory)).toBe(secret);
		expect(await mode(path.join(directory, 'media-stream-secret'))).toBe(0o600);
	}
	finally {
		database?.close();
		await rm(root, { recursive: true, force: true });
	}
});

it('executes the real migration worker from the prior schema with protected database files', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-private-upgrade-'));
	let database: ReturnType<typeof createDatabase> | undefined;
	try {
		const migrations = path.resolve('drizzle');
		const journal = JSON.parse(await readFile(path.join(migrations, 'meta/_journal.json'), 'utf8'));
		const upgradeIndex = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0045_media_servers');
		expect(upgradeIndex).toBeGreaterThan(0);
		const priorEntries = journal.entries.slice(0, upgradeIndex);
		const prior = path.join(root, 'prior');
		await mkdir(path.join(prior, 'meta'), { recursive: true });
		await writeFile(path.join(prior, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: priorEntries }));
		await Promise.all(priorEntries.map((entry: { tag: string }) => copyFile(path.join(migrations, `${entry.tag}.sql`), path.join(prior, `${entry.tag}.sql`))));
		const file = path.join(root, 'custom-parent', 'moirai.sqlite');
		database = createDatabase(file, prior);
		expect(database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_servers'").get()).toBeUndefined();
		const priorMarkers = database.sqlite.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at').all();
		expect(priorMarkers).toHaveLength(priorEntries.length);
		const repository = new Repository(database.db);
		await repository.setPlaybackSettings({ ...(await repository.getPlaybackSettings()), maxActiveSessions: 3 });
		const previousSettings = database.sqlite.prepare('SELECT * FROM settings').all();
		database.close();
		database = undefined;
		await chmod(path.dirname(file), 0o755);
		await chmod(file, 0o644);
		await runMigrationsInWorker(file, migrations, () => undefined);
		database = createDatabase(file, migrations);
		expect(database.sqlite.prepare('SELECT * FROM settings').all()).toEqual(previousSettings);
		expect(database.sqlite.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at').all().slice(0, priorEntries.length)).toEqual(priorMarkers);
		expect((await new Repository(database.db).getPlaybackSettings()).maxActiveSessions).toBe(3);
		expect(database.sqlite.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get()).toEqual({ count: journal.entries.length });
		expect(database.sqlite.prepare('SELECT count(*) AS count FROM media_servers').get()).toEqual({ count: 0 });
		expect(await mode(file)).toBe(0o600);
		expect(await mode(path.dirname(file))).toBe(0o755);
	}
	finally {
		database?.close();
		await rm(root, { recursive: true, force: true });
	}
});
