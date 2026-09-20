import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '@server/db/index.js';
import { applyPendingMigrations, runMigrationsInWorker } from '@server/db/migrations.js';

const databases: Array<ReturnType<typeof createDatabase>> = [];
const migrationsDir = path.resolve('drizzle');

afterEach(() => {
	databases.splice(0).forEach((database) => database.close());
});

describe('pending migration application', () => {
	it('applies pending migrations even when historical markers outnumber the journal', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'moirai-old-markers-'));
		const sqlite = new Database(':memory:');
		try {
			await mkdir(path.join(root, 'meta'));
			await writeFile(path.join(root, 'meta/_journal.json'), JSON.stringify({ entries: [{ idx: 0, when: 1000, tag: 'repair' }] }));
			await writeFile(path.join(root, 'repair.sql'), 'CREATE TABLE repaired (value TEXT);');
			sqlite.exec("CREATE TABLE __drizzle_migrations(id INTEGER PRIMARY KEY, hash TEXT, created_at NUMERIC); INSERT INTO __drizzle_migrations(hash,created_at) VALUES ('old-a',1),('old-b',2)");
			const progress: number[] = [];
			applyPendingMigrations(sqlite, root, (entry) => progress.push(entry.applied));
			expect(progress).toEqual([0, 1]);
			expect(sqlite.prepare('SELECT * FROM repaired').all()).toEqual([]);
			expect(sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()).toEqual({ count: 3 });
		}
		finally {
			sqlite.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it('writes the same Drizzle markers createDatabase would, then is a no-op', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'moirai-migrate-'));
		const databasePath = path.join(root, 'moirai.sqlite');
		const first = createDatabase(databasePath, migrationsDir);
		const markers = first.sqlite.prepare(
			'SELECT created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at',
		).all();
		first.close();

		const secondPath = path.join(root, 'second.sqlite');
		const raw = new Database(secondPath);
		const progress: string[] = [];
		applyPendingMigrations(raw, migrationsDir, (entry) => {
			progress.push(`${entry.applied}/${entry.total}`);
		});
		const applied = raw.prepare(
			'SELECT created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at',
		).all();
		raw.close();
		expect(applied).toEqual(markers);
		expect(progress[0]).toBe(`0/${markers.length}`);
		expect(progress.at(-1)).toBe(`${markers.length}/${markers.length}`);

		const opened = createDatabase(secondPath, migrationsDir);
		databases.push(opened);
		expect(opened.sqlite.prepare(
			'SELECT created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at',
		).all()).toEqual(markers);
	});

	it('reports worker progress then leaves createDatabase with nothing to apply', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'moirai-migrate-worker-'));
		const databasePath = path.join(root, 'moirai.sqlite');
		const seen: number[] = [];
		await runMigrationsInWorker(databasePath, migrationsDir, (progress) => {
			seen.push(progress.applied);
		});
		expect(seen[0]).toBe(0);
		expect(seen.at(-1)).toBeGreaterThan(0);
		const database = createDatabase(databasePath, migrationsDir);
		databases.push(database);
		expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get())
			.toEqual({ count: seen.at(-1) });
	});
});
