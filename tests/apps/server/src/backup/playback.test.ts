import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { channelCreateSchema, libraryCreateSchema } from '@moirai/shared';
import { loadConfig } from '@server/config.js';
import { createDatabase } from '@server/db/index.js';
import { buildApp } from '@server/app.js';

// Opt in with the real playback engine and FFmpeg; ordinary CI does not require native binaries.
it.skipIf(!process.env.MOIRAI_TEST_PLAYBACK_ENGINE || !process.env.MOIRAI_TEST_FFMPEG)(
	'delivers decodable HLS while backup capture waits on a write and scans, guide, and preparation contend',
	async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-backup-playback-'));
		const config = loadConfig({ dataDir: root, logLevel: 'silent', timeZone: 'UTC', schedulingWorkerCount: 1,
			playbackEnginePath: process.env.MOIRAI_TEST_PLAYBACK_ENGINE!, ffprobePath: path.join(path.dirname(process.env.MOIRAI_TEST_FFMPEG!), 'ffprobe'),
			playbackReadyTimeoutMs: 60_000, migrationsDir: path.resolve('drizzle'), guideDays: 1 });
		const database = createDatabase(config.databasePath, config.migrationsDir);
		const { app, services } = await buildApp(config, database.db);
		let release!: () => void;
		let admitted!: () => void;
		const admission = new Promise<void>(resolve => {
			admitted = resolve; 
		});
		const gate = new Promise<void>(resolve => {
			release = resolve; 
		});
		app.post('/backup-contention-fixture', { config: { authentication: 'public' } }, async () => {
			admitted();
			await gate;
			return {};
		});
		let held: Promise<unknown> | undefined;
		let backup: Promise<unknown> | undefined;
		let background: Promise<unknown[]> | undefined;
		try {
			await app.ready();
			const channel = await services.repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Backup contention', video: { width: 320, height: 180, accel: null } }));
			const library = await services.repository.createLibrary(libraryCreateSchema.parse({ name: 'Bundled source', typeKey: 'movies', sourceType: 'on-disk',
				sourceConfig: { scanRoot: path.resolve('apps/server/assets') }, watcherEnabled: false }));
			held = app.inject({ method: 'POST', url: '/backup-contention-fixture' }).then(response => response);
			await admission;
			let backupComplete = false;
			backup = services.backups.create().then(() => {
				backupComplete = true; 
			});
			const started = performance.now();
			background = Promise.allSettled([services.scanner.scan(library.id, 'manual'), services.playout.syncAll(), app.inject('/epg.xml')]);
			const master = await app.inject('/iptv/channel/1.m3u8');
			expect(master.statusCode, master.body).toBe(200);
			const playlist = await app.inject(`/iptv/session/${channel.id}/live.m3u8`);
			expect(playlist.statusCode).toBe(200);
			const member = playlist.body.split('\n').find(line => line.trim() && !line.startsWith('#'))!;
			const segment = await app.inject(`/iptv/session/${channel.id}/${path.basename(member)}`);
			expect(segment.statusCode).toBe(200);
			expect(segment.rawPayload.length).toBeGreaterThan(0);
			expect(backupComplete).toBe(false);
			const filename = path.join(root, 'delivered.ts');
			await writeFile(filename, segment.rawPayload);
			await promisify(execFile)(process.env.MOIRAI_TEST_FFMPEG!, ['-v', 'error', '-i', filename, '-frames:v', '1', '-f', 'null', '-']);
			console.info(`Backup contention: first decodable delivered segment in ${Math.round(performance.now() - started)} ms`);
			release();
			await held;
			await backup;
			const continued = await app.inject(`/iptv/session/${channel.id}/live.m3u8`);
			expect(continued.statusCode).toBe(200);
			await background;
		}
		finally {
			release();
			await held;
			await backup?.catch(() => undefined);
			await background;
			await app.close();
			database.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	90_000,
);
