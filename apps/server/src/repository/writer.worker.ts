import { parentPort, workerData } from 'node:worker_threads';
import { openWriteDatabase } from '../db/write-connection.js';
import { Repository } from './index.js';
import type { WriteError } from './write-errors.js';
import { executeWrite, type WriteCommand } from './write-commands.js';

/** Connection retained by the serial runtime write owner. */
const database = openWriteDatabase((workerData as { databasePath: string }).databasePath);
/** Transaction facade private to this thread. */
const repository = new Repository(database.db);
/** Dedicated transport to the main-process coordinator. */
const port = parentPort!;
let pending = Promise.resolve();
port.on('message', (message: { id: number; command: WriteCommand }) => {
	pending = pending.then(async () => {
		const started = performance.now();
		try {
			const result = await executeWrite(repository, message.command);
			port.postMessage({ id: message.id, result, databaseMs: performance.now() - started });
		}
		catch (error) {
			const value = error as Error & WriteError;
			port.postMessage({ id: message.id, error: { name: value.constructor.name, message: value.message,
				statusCode: value.statusCode, code: value.code, expose: value.expose,
				resourceType: value.resourceType, identityType: value.identityType, issues: value.issues } });
		}
	});
});
