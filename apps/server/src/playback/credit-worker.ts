import { parentPort, workerData } from 'node:worker_threads';
import { renderCredits } from './credit-render.js';

try {
	parentPort?.postMessage({ ass: await renderCredits(workerData.source, workerData.context) });
}
catch (cause) {
	parentPort?.postMessage({ error: cause instanceof Error ? cause.message : 'Unable to render credits' });
}
