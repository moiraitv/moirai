import process from 'node:process';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { recoveryManagementUrl } from './auth/recovery-url.js';
import { AuthenticationService } from './auth/service.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/index.js';
import { Repository } from './repository/index.js';

/** Issue one short-lived recovery URL without accepting a plaintext password from the shell. */
async function main(): Promise<void> {
	const config = loadConfig();
	const database = createDatabase(config.databasePath, config.migrationsDir);
	const shell = Fastify({ logger: false });
	try {
		const authentication = new AuthenticationService(
			new Repository(database.db),
			config,
			shell.log as FastifyBaseLogger,
			null,
		);
		const token = await authentication.issueRecoveryToken();
		const url = new URL('/recover', await recoveryManagementUrl(config));
		url.hash = new URLSearchParams({ token }).toString();
		process.stdout.write([
			'Local administrator recovery is available for 15 minutes:',
			url.href,
			'',
		].join('\n'));
	}
	finally {
		database.close();
		await shell.close();
	}
}

await main();
