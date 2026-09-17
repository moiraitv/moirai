import { mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { buildApp } from './app.js';
import { loadConfig, publicUrlStatus } from './config.js';
import {
	startBootstrapServer,
	stopBootstrapServer,
	type BootstrapMigrationState,
} from './db/bootstrap-http.js';
import { createDatabase } from './db/index.js';
import {
	migrationProgressFromSqlite,
	runMigrationsInWorker,
	type MigrationProgress,
} from './db/migrations.js';
import { listenWithAddressRetry } from './listen.js';

/** Peek journal progress without holding the database open. */
function peekMigrationProgress(databasePath: string, migrationsDir: string): MigrationProgress {
	const sqlite = new Database(databasePath);
	try {
		return migrationProgressFromSqlite(sqlite, migrationsDir);
	}
	finally {
		sqlite.close();
	}
}

/** Serve a public updating page while pending Drizzle files apply in a worker. */
async function runStartupMigrations(
	databasePath: string,
	migrationsDir: string,
	host: string,
	port: number,
): Promise<Server | undefined> {
	const initial = peekMigrationProgress(databasePath, migrationsDir);
	if (initial.applied >= initial.total) {
		return undefined;
	}

	console.info(
		`Applying database migrations (${initial.applied} of ${initial.total} files; ${initial.currentTag ?? 'pending'})`,
	);
	const bootstrapState: BootstrapMigrationState = {
		status: 'migrating',
		progress: initial,
	};
	const bootstrap = await startBootstrapServer(host, port, bootstrapState);
	try {
		await runMigrationsInWorker(databasePath, migrationsDir, (progress) => {
			bootstrapState.progress = progress;
		});
		const remaining = peekMigrationProgress(databasePath, migrationsDir);
		if (remaining.applied < remaining.total) {
			throw new Error(
				`Migration worker finished with ${remaining.total - remaining.applied} pending files`,
			);
		}
		console.info('Database migrations finished');
		return bootstrap;
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		bootstrapState.status = 'failed';
		bootstrapState.error = message;
		console.error(`Database migrations failed: ${message}`);
		console.error('Moirai is parked on the updating page until the process is stopped.');
		await new Promise<void>((resolve) => {
			process.once('SIGINT', () => resolve());
			process.once('SIGTERM', () => resolve());
		});
		await stopBootstrapServer(bootstrap);
		process.exit(1);
	}
}

/** Validated process configuration shared by bootstrap services. */
const config = loadConfig();
/** Whether the development coordinator owns immediate process termination. */
const developmentWatch = process.env.MOIRAI_DEV_WATCH === '1';
if (developmentWatch) {
	// Native watcher and SQLite cleanup can remain in macOS's exiting state for an extended period.
	// Development scans are recoverable, so bypass cleanup and guarantee prompt process teardown.
	const forceExit = () => process.kill(process.pid, 'SIGKILL');
	process.once('SIGINT', forceExit);
	process.once('SIGTERM', forceExit);
	if (process.connected) {
		process.once('disconnect', forceExit);
	}
}
await mkdir(config.dataDir, { recursive: true });
const bootstrap = await runStartupMigrations(
	config.databasePath,
	config.migrationsDir,
	config.host,
	config.port,
);
/** SQLite connection owned for the lifetime of this server process. */
const database = createDatabase(config.databasePath, config.migrationsDir);
const { app, services } = await buildApp(config, database.db);
if (publicUrlStatus(config.publicUrl) === 'unreachable-default') {
	app.log.warn(
		{ publicUrl: config.publicUrl },
		'MOIRAI_PUBLIC_URL is loopback-only; remote IPTV clients cannot use generated URLs',
	);
}

let shutdownPromise: Promise<void> | undefined;
/** Stop the server once and share the same cleanup promise with every signal. */
const shutdown = (): Promise<void> => {
	shutdownPromise ??= (async () => {
		// Fastify cannot release its listener while upgraded WebSocket connections remain open.
		// Disconnect them first so development restarts can promptly reclaim the API port.
		services.events.close({ terminate: true });
		await app.close();
		await services.scanner.close();
		database.close();
	})();
	return shutdownPromise;
};

if (!developmentWatch) {
	const boundedShutdown = (): void => {
		const deadline = setTimeout(() => process.exit(1), config.shutdownDeadlineMs);
		deadline.unref();
		void shutdown().finally(() => {
			clearTimeout(deadline);
			process.exit(0);
		});
	};
	process.once('SIGINT', boundedShutdown);
	process.once('SIGTERM', boundedShutdown);
}

/** Bind the configured listener and normalize Fastify's resolved address value. */
const listen = () => app.listen({ host: config.host, port: config.port }).then(() => undefined);
if (bootstrap) {
	await stopBootstrapServer(bootstrap);
}
await listenWithAddressRetry(listen, {
	attempts: developmentWatch ? 40 : 20,
	delayMs: 250,
	onRetry: (attempt) => {
		app.log.warn(
			{ port: config.port, attempt },
			'API port is still held by the prior process; retrying',
		);
	},
});
if (developmentWatch && process.send) {
	process.send({ type: 'ready' });
}
try {
	await services.scanner.start();
}
catch (error) {
	app.log.error({ error }, 'Library scanner startup failed; API remains available');
}
