import { buildEtvPlayoutFiles } from '../playback/playout-output.js';
import { timedJob } from './job-timing.js';
import { DatabaseJobReader, type DatabaseReadRequest } from './database-jobs.js';
import { TimelineMaterializer } from './timeline-materializer.js';
import { schedulingWorkerError, type SchedulingWorkerErrorPayload } from './worker-pool.js';
import { parentPort, workerData } from 'node:worker_threads';
import type { GenerateTimelineInput } from './engine.js';
import { generateTimelineDetailed, TimelineMaterializationLimitError } from './engine.js';
import { indexSchedulingCatalog } from './catalog.js';
import { openReadOnlyDatabase } from '../db/read-only.js';
import { PreviewExecutor, type PreviewJob } from './preview.js';

if (!parentPort) {
	throw new Error('Scheduling worker must run in a worker thread');
}

let cachedCatalog: GenerateTimelineInput['catalog'] | null = null;
let cachedCatalogKey: string | null = null;

let preview: PreviewExecutor | null = null;
let reader: DatabaseJobReader | null = null;
let nextWriteId = 0;
const writes = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

/** Open the worker's database once, sharing it across serial jobs without startup side effects. */
function databaseReader(): DatabaseJobReader {
	if (!reader) {
		const database = openReadOnlyDatabase(workerData.databasePath);
		process.once('exit', () => database.close());
		reader = new DatabaseJobReader(database.db);
	}
	return reader;
}

parentPort.on('message', async (message: {
	id: number;
	kind: 'generate';
	catalogKey: string | null;
	input: Omit<GenerateTimelineInput, 'catalog'> & { catalog?: GenerateTimelineInput['catalog'] };
} | { id: number; kind: 'preview'; input: PreviewJob }
| { id: number; kind: 'read'; input: { request: DatabaseReadRequest; revision: string } }
| { id: number; kind: 'playout'; input: Parameters<typeof buildEtvPlayoutFiles> }
| { id: number; kind: 'materialize'; input: { timeZone: string; revision: string } }
| { kind: 'write-result'; writeId: number; error?: SchedulingWorkerErrorPayload }) => {
	if (message.kind === 'write-result') {
		const pending = writes.get(message.writeId);
		writes.delete(message.writeId);
		if (message.error) {
			pending?.reject(schedulingWorkerError(message.error));
		}
		else {
			pending?.resolve();
		}
		return;
	}
	try {
		if (message.kind === 'playout') {
			parentPort!.postMessage({ id: message.id, result: buildEtvPlayoutFiles(...message.input) });
			return;
		}
		if (message.kind === 'read') {
			const result = await timedJob(() => databaseReader().read(message.input.request, message.input.revision));
			parentPort!.postMessage({ id: message.id, ...result });
			return;
		}
		if (message.kind === 'materialize') {
			const owner = databaseReader();
			owner.invalidate(message.input.revision);
			const materializer = new TimelineMaterializer(
				owner.repository,
				{ publish: event => parentPort!.postMessage({ id: message.id, event }) },
				message.input.timeZone,
				undefined,
				write => new Promise<void>((resolve, reject) => {
					const writeId = nextWriteId++;
					writes.set(writeId, { resolve, reject });
					parentPort!.postMessage({ id: message.id, writeId, write });
				}),
			);
			await materializer.runNow();
			parentPort!.postMessage({ id: message.id, result: materializer.needsRefresh });
			return;
		}
		if (message.kind === 'preview') {
			if (!preview) {
				const database = openReadOnlyDatabase(workerData.databasePath);
				process.once('exit', () => database.close());
				preview = new PreviewExecutor(database.db);
			}
			const result = await preview.run(message.input);
			parentPort!.postMessage({ id: message.id, result });
			return;
		}

		if (message.input.catalog) {
			cachedCatalog = indexSchedulingCatalog(message.input.catalog);
			cachedCatalogKey = message.catalogKey;
		}
		if (!cachedCatalog || cachedCatalogKey !== message.catalogKey) {
			throw new Error('Scheduling worker catalog cache is unavailable');
		}

		const result = generateTimelineDetailed({
			...message.input,
			catalog: cachedCatalog,
		});
		parentPort!.postMessage({ id: message.id, result });
	}
	catch (error) {
		parentPort!.postMessage({
			id: message.id,
			error: error instanceof Error
				? {
					...error,
					name: error.name,
					message: error.message,
					...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
					...('expose' in error && error.expose === true ? { expose: true } : {}),
					...('statusCode' in error && typeof error.statusCode === 'number'
						? { statusCode: error.statusCode }
						: {}),
					...(error instanceof TimelineMaterializationLimitError
						? { limit: error.limit }
						: {}),
				}
				: { message: String(error) },
		});
	}
});
