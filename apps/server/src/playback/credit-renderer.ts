import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/** Maximum simultaneous preview or playout template renders. */
export const MAX_ACTIVE_CREDIT_RENDERS = 2;
/** Bound queued contexts while allowing ordinary channel and preview work to share capacity. */
export const MAX_PENDING_CREDIT_RENDERS = 32;
/** Active renders are bounded because author-supplied templates consume worker memory. */
let activeRenders = 0;
/** FIFO waiters receive ownership of a released worker slot. */
const waiters: Array<() => void> = [];

/** Bound overload: playback omits optional credits, while interactive requests can retry. */
export class CreditRendererBusyError extends Error {
	constructor() {
		super('Credit renderer is busy; retry shortly');
	}
}

/** Acquire a worker slot or join the bounded queue without consuming execution time. */
async function acquireSlot(): Promise<void> {
	if (activeRenders < MAX_ACTIVE_CREDIT_RENDERS) {
		activeRenders += 1;
		return;
	}
	if (waiters.length >= MAX_PENDING_CREDIT_RENDERS) {
		throw new CreditRendererBusyError();
	}
	await new Promise<void>((resolve) => waiters.push(resolve));
}

/** Transfer slot ownership to the oldest waiter, including after failed worker execution. */
function releaseSlot(): void {
	const next = waiters.shift();
	if (next) {
		next();
	}
	else {
		activeRenders -= 1;
	}
}

/** Render one document in a disposable worker with a hard wall-clock deadline. */
export async function renderCreditTemplate(source: string, context: Record<string, unknown>): Promise<string> {
	await acquireSlot();
	const compiled = new URL('./credit-worker.js', import.meta.url);
	const hasCompiled = existsSync(fileURLToPath(compiled));
	let worker: Worker | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		worker = new Worker(hasCompiled ? compiled : new URL('./credit-worker.ts', import.meta.url), {
			execArgv: hasCompiled ? [] : ['--import', 'tsx'],
			workerData: { source, context },
			resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
		});
		return await new Promise<string>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error('Credit template exceeded its execution limit')), 5_000);
			worker!.once('message', (result: { ass?: string; error?: string }) => {
				if (result.ass !== undefined) {
					resolve(result.ass);
				}
				else {
					reject(new Error(result.error ?? 'Unable to render credits'));
				}
			});
			worker!.once('error', reject);
			worker!.once('exit', () => reject(new Error('Credit renderer exited before completing')));
		});
	}
	finally {
		clearTimeout(timer);
		try {
			await worker?.terminate();
		}
		finally {
			releaseSlot();
		}
	}
}
