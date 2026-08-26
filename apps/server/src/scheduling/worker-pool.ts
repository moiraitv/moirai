import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { MAX_TIMELINE_SEGMENTS } from '@moirai/shared';
import type { GenerateTimelineInput, TimelineGeneration } from './engine.js';
import { generateTimelineDetailed, TimelineMaterializationLimitError } from './engine.js';

/** Report bounded scheduling work rejected because every worker slot is occupied. */
export class SchedulingQueueFullError extends Error {
	readonly statusCode = 503;

	constructor(readonly limit: number) {
		super(`Scheduling worker queue is at its ${limit} request limit`);
		this.name = 'SchedulingQueueFullError';
	}
}

/** Timeline-generation request queued for a worker thread. */
interface Job {
	id: number;
	input: GenerateTimelineInput;
	resolve: (value: TimelineGeneration) => void;
	reject: (error: Error) => void;
}

/** Worker thread and the single generation job currently assigned to it. */
interface WorkerSlot {
	worker: Worker;
	job: Job | null;
	catalogKey: string | null;
}

/** Serializable error details returned across the worker boundary. */
export interface SchedulingWorkerErrorPayload {
	name?: string;
	message: string;
	statusCode?: number;
	limit?: number;
}

/** Restore expected domain errors that lose their prototype across a worker boundary. */
export function schedulingWorkerError(payload: SchedulingWorkerErrorPayload): Error {
	if (payload.name === 'TimelineMaterializationLimitError') {
		return new TimelineMaterializationLimitError(payload.limit ?? MAX_TIMELINE_SEGMENTS);
	}

	const error = new Error(payload.message);
	error.name = payload.name ?? 'Error';
	if (payload.statusCode) {
		Object.assign(error, { statusCode: payload.statusCode });
	}
	return error;
}

/**
 * Bound CPU-heavy timeline generation and offload production work from Fastify's event loop. The pool
 * enforces fixed worker and queue capacity, propagates worker failures, and can retire idle workers
 * when the process needs to release resources.
 */
export class SchedulingWorkerPool {
	private readonly slots: WorkerSlot[] = [];
	private readonly queue: Job[] = [];
	private nextId = 1;
	private closing = false;
	private readonly workerUrl: URL;
	private readonly workerExecArgv: string[];

	constructor(
		private readonly workerCount: number,
		private readonly queueLimit: number,
	) {
		const compiledWorker = new URL('./worker.js', import.meta.url);
		if (existsSync(fileURLToPath(compiledWorker))) {
			this.workerUrl = compiledWorker;
			this.workerExecArgv = [];
		}
		else {
			this.workerUrl = new URL('./worker.ts', import.meta.url);
			this.workerExecArgv = ['--import', 'tsx'];
		}
	}

	/** Generate a timeline in a worker, falling back to the main thread when disabled. */
	async generate(input: GenerateTimelineInput): Promise<TimelineGeneration> {
		if (this.closing) {
			throw new Error('Scheduling workers are shutting down');
		}

		if (this.workerCount === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			return generateTimelineDetailed(input);
		}

		if (this.queue.length + this.slots.filter((slot) => slot.job).length >= this.queueLimit) {
			throw new SchedulingQueueFullError(this.queueLimit);
		}

		this.ensureWorkers();
		return new Promise<TimelineGeneration>((resolve, reject) => {
			this.queue.push({ id: this.nextId++, input, resolve, reject });
			this.dispatch();
		});
	}

	/** Reject queued work and terminate every scheduling worker. */
	async close(): Promise<void> {
		this.closing = true;
		const error = new Error('Scheduling workers shut down before completing the request');
		this.queue.splice(0).forEach((job) => job.reject(error));
		for (const slot of this.slots) {
			slot.job?.reject(error);
			slot.job = null;
		}
		await Promise.allSettled(this.slots.splice(0).map((slot) => slot.worker.terminate()));
	}

	/** Retire idle worker threads so essential operations can reclaim process capacity. */
	async retireIdleWorkers(): Promise<void> {
		const idle = this.slots.filter((slot) => !slot.job);
		for (const slot of idle) {
			const index = this.slots.indexOf(slot);
			if (index >= 0) {
				this.slots.splice(index, 1);
			}
		}
		await Promise.allSettled(idle.map((slot) => slot.worker.terminate()));
	}

	/** Create worker slots until the configured pool size is available. */
	private ensureWorkers(): void {
		while (this.slots.length < this.workerCount) {
			this.addWorker();
		}
	}

	/** Start a worker and attach lifecycle handlers before accepting jobs. */
	private addWorker(): void {
		const worker = new Worker(this.workerUrl, { execArgv: this.workerExecArgv });
		const slot: WorkerSlot = { worker, job: null, catalogKey: null };
		this.slots.push(slot);
		worker.on(
			'message',
			(message: {
				id: number;
				result?: TimelineGeneration;
				error?: SchedulingWorkerErrorPayload;
			}) => {
				const job = slot.job;
				if (!job || job.id !== message.id) {
					return;
				}

				slot.job = null;
				if (message.error) {
					job.reject(schedulingWorkerError(message.error));
				}
				else {
					job.resolve(message.result!);
				}
				this.dispatch();
			},
		);
		const failed = (error: Error): void => {
			slot.job?.reject(error);
			slot.job = null;
			const index = this.slots.indexOf(slot);
			if (index >= 0) {
				this.slots.splice(index, 1);
			}
			if (!this.closing) {
				this.addWorker();
				this.dispatch();
			}
		};
		worker.once('error', failed);
		worker.once('exit', (code) => {
			if (code !== 0 && this.slots.includes(slot)) {
				failed(new Error(`Scheduling worker exited with code ${code}`));
			}
		});
	}

	/** Assign queued scheduling jobs to idle workers. */
	private dispatch(): void {
		for (const slot of this.slots) {
			if (slot.job) {
				continue;
			}

			const job = this.queue.shift();
			if (!job) {
				return;
			}

			slot.job = job;
			const catalogKey = job.input.catalog.cacheKey ?? null;
			const reuseCatalog = Boolean(catalogKey && slot.catalogKey === catalogKey);
			slot.worker.postMessage({
				id: job.id,
				catalogKey,
				input: reuseCatalog ? { ...job.input, catalog: undefined } : job.input,
			});
			if (!reuseCatalog) {
				slot.catalogKey = catalogKey;
			}
		}
	}
}
