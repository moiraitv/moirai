import { parentPort } from 'node:worker_threads';
import type { GenerateTimelineInput } from './engine.js';
import { generateTimelineDetailed, TimelineMaterializationLimitError } from './engine.js';
import { indexSchedulingCatalog } from './catalog.js';

if (!parentPort) {
	throw new Error('Scheduling worker must run in a worker thread');
}

let cachedCatalog: GenerateTimelineInput['catalog'] | null = null;
let cachedCatalogKey: string | null = null;

parentPort.on('message', (message: {
	id: number;
	catalogKey: string | null;
	input: Omit<GenerateTimelineInput, 'catalog'> & { catalog?: GenerateTimelineInput['catalog'] };
}) => {
	try {
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
					name: error.name,
					message: error.message,
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
