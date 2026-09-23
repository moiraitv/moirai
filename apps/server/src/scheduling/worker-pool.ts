import { buildEtvPlayoutFiles } from '../playback/playout-output.js';
import type { JobTimings } from './job-timing.js';
import type { ResponsivenessMonitor } from '../operations/responsiveness.js';
import type { LiveEventInput } from '@moirai/shared';
import { DatabaseJobReader, type DatabaseReadRequest, type DatabaseReadResult } from './database-jobs.js';
import type { MaterializationWrite, MaterializationWriter } from './materialization-writes.js';
import { consumeRead, type SharedRead } from './shared-read.js';
import { CommittedGuideUnavailableError, CommittedGuideRangeError, GuideMaterializationLimitError } from '../guide/schedule-guide.js';
import { DuplicateTvgIdError } from '../guide/epg.js';
import { StaleSemanticDecisionError } from '../repository/semantic.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { MAX_TIMELINE_SEGMENTS } from '@moirai/shared';
import type { GenerateTimelineInput, TimelineGeneration } from './engine.js';
import { generateTimelineDetailed, TimelineMaterializationLimitError } from './engine.js';
import { TimelineIssueLimitError } from './timeline-issues.js';
import { SchedulingValidationError } from './validation.js';
import { PreviewExecutor, type PreviewJob, type PreviewRequest, type PreviewResults } from './preview.js';
import type { MoiraiDatabase } from '../db/index.js';
import type { Repository } from '../repository/index.js';

/** Report bounded scheduling work rejected because every worker slot is occupied. */
export class SchedulingQueueFullError extends Error {
	readonly statusCode = 503;

	constructor(readonly limit: number) {
		super(`Scheduling worker queue is at its ${limit} request limit`);
		this.name = 'SchedulingQueueFullError';
	}
}

/** Payloads accepted by the shared bounded scheduling queue. */
type JobInput = { kind: 'generate'; input: GenerateTimelineInput }
	| { kind: 'preview'; input: PreviewJob }
	| { kind: 'read'; input: { request: DatabaseReadRequest; revision: string } }
	| { kind: 'playout'; input: Parameters<typeof buildEtvPlayoutFiles> }
	| { kind: 'materialize'; input: { timeZone: string; revision: string } };

/** Main-connection fallback and invalidation source for database-backed preview jobs. */
interface PreviewContext {
	db: MoiraiDatabase;
	repository: Repository;
	responsiveness?: ResponsivenessMonitor;
}

/** Scheduling request queued for a worker thread. */
interface Job {
	id: number;
	task: JobInput;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	background: boolean;
	queuedAt: number;
	cleanup?: () => void;
	finish?: (() => void) | undefined;
	write?: MaterializationWriter;
	event?: (event: LiveEventInput) => void;
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
	code?: string;
	expose?: boolean;
	limit?: number;
	channelCount?: number;
	startDate?: string;
	endDate?: string;
	tvgId?: string;
}

/** Restore expected domain errors that lose their prototype across a worker boundary. */
export function schedulingWorkerError(payload: SchedulingWorkerErrorPayload): Error {
	if (payload.name === 'CommittedGuideUnavailableError') {
		return new CommittedGuideUnavailableError(payload.channelCount ?? 1);
	}
	if (payload.name === 'CommittedGuideRangeError') {
		return new CommittedGuideRangeError(payload.startDate!, payload.endDate!);
	}
	if (payload.name === 'GuideMaterializationLimitError') {
		return new GuideMaterializationLimitError(payload.limit!);
	}
	if (payload.name === 'DuplicateTvgIdError') {
		return new DuplicateTvgIdError(payload.tvgId!);
	}
	if (payload.name === 'StaleSemanticDecisionError') {
		return new StaleSemanticDecisionError(payload.message);
	}
	if (payload.name === 'SchedulingValidationError') {
		return new SchedulingValidationError(payload.message);
	}
	if (payload.name === 'TimelineIssueLimitError') {
		return new TimelineIssueLimitError();
	}
	if (payload.name === 'TimelineMaterializationLimitError') {
		return new TimelineMaterializationLimitError(payload.limit ?? MAX_TIMELINE_SEGMENTS);
	}

	const error = new Error(payload.message);
	error.name = payload.name ?? 'Error';
	if (payload.code) {
		Object.assign(error, { code: payload.code });
	}
	if (payload.expose === true) {
		Object.assign(error, { expose: true });
	}
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
	private localPreview: PreviewExecutor | null = null;
	private localReader: DatabaseJobReader | null = null;
	private readRevision = 0;
	private interactiveStreak = 0;
	private readonly previews = new Map<string, SharedRead<PreviewResults[PreviewRequest['kind']]>>();
	private readonly reads = new Map<string, SharedRead<DatabaseReadResult>>();

	/** Drop in-flight read identities when authoritative data changes. */
	invalidateReads(): void {
		this.readRevision += 1;
	}

	/** File-backed databases can be read independently without transferring their catalogs. */
	get databaseBacked(): boolean {
		return Boolean(this.workerCount > 0 && this.previewContext && !this.previewContext.db.$client.memory);
	}

	/** Coalesce identical reads while preserving independent cancellation for every caller. */
	read(request: DatabaseReadRequest, signal?: AbortSignal): Promise<DatabaseReadResult> {
		if (this.closing || !this.previewContext) {
			return Promise.reject(new Error('Scheduling reads are unavailable'));
		}
		const revision = `${this.previewContext.repository.schedulingCatalogRevision}:${this.readRevision}`;
		const key = JSON.stringify([revision, request]);
		let shared = this.reads.get(key);
		if (!shared || shared.controller.signal.aborted) {
			const controller = new AbortController();
			const promise = this.databaseBacked
				? this.enqueue<DatabaseReadResult>({ kind: 'read', input: { request, revision } }, controller.signal)
				: (this.localReader ??= new DatabaseJobReader(this.previewContext.db)).read(request, revision);
			shared = { promise, controller, consumers: 0 };
			const owned = shared;
			this.reads.set(key, shared);
			void promise.finally(() => {
				if (this.reads.get(key) === owned) {
					this.reads.delete(key);
				}
			}).catch(() => undefined);
		}
		return consumeRead(shared, signal);
	}

	/** Keep the complete background preparation pass off-thread and acknowledge ordered writes. */
	materialize(timeZone: string, write: MaterializationWriter, event: (event: LiveEventInput) => void): Promise<boolean> {
		const revision = `${this.previewContext!.repository.schedulingCatalogRevision}:${this.readRevision}`;
		return this.enqueue<boolean>({ kind: 'materialize', input: { timeZone, revision } }, undefined, { write, event });
	}

	constructor(
		private readonly workerCount: number,
		private readonly queueLimit: number,
		private readonly previewContext?: PreviewContext,
	) {
		const compiledWorker = new URL('./worker.js', import.meta.url);
		if (existsSync(fileURLToPath(compiledWorker))) {
			this.workerUrl = compiledWorker;
			this.workerExecArgv = process.execArgv;
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

		return this.enqueue<TimelineGeneration>({ kind: 'generate', input });
	}

	/** Resolve a draft entirely in a worker, retaining local support for in-memory databases. */
	async preview<K extends PreviewRequest['kind']>(
		request: Extract<PreviewRequest, { kind: K }>,
		signal?: AbortSignal,
	): Promise<PreviewResults[K]> {
		if (this.closing) {
			throw new Error('Scheduling workers are shutting down');
		}
		const context = this.previewContext;
		if (!context) {
			throw new Error('Scheduling previews require a database context');
		}

		const input = { request, revision: context.repository.schedulingCatalogRevision };
		if (this.workerCount === 0 || context.db.$client.memory) {
			this.localPreview ??= new PreviewExecutor(context.db);
			await new Promise<void>((resolve) => setImmediate(resolve));
			return await this.localPreview.run(input) as PreviewResults[K];
		}
		const key = JSON.stringify(input);
		let shared = this.previews.get(key);
		if (!shared || shared.controller.signal.aborted) {
			const controller = new AbortController();
			const promise = this.enqueue<PreviewResults[K]>({ kind: 'preview', input }, controller.signal);
			shared = { promise, controller, consumers: 0 };
			const owned = shared;
			this.previews.set(key, shared);
			void promise.finally(() => {
				if (this.previews.get(key) === owned) {
					this.previews.delete(key);
				}
			}).catch(() => undefined);
		}
		return consumeRead(shared, signal) as Promise<PreviewResults[K]>;
	}

	/** Prepare validated playout documents off-thread while their owner retains publication rights. */
	async playout(input: Parameters<typeof buildEtvPlayoutFiles>): Promise<Map<string, string>> {
		if (this.closing) {
			throw new Error('Scheduling workers are shutting down');
		}
		if (this.workerCount === 0) {
			return buildEtvPlayoutFiles(...input);
		}
		return this.enqueue({ kind: 'playout', input });
	}

	/** Admit either job kind through the same worker and queue capacity limits. */
	private enqueue<T>(
		task: JobInput,
		signal?: AbortSignal,
		callbacks: Pick<Job, 'write' | 'event'> = {},
	): Promise<T> {
		if (this.closing) {
			return Promise.reject(new Error('Scheduling workers are shutting down'));
		}
		if (this.queue.length + this.slots.filter((slot) => slot.job).length >= this.queueLimit) {
			throw new SchedulingQueueFullError(this.queueLimit);
		}

		this.ensureWorkers();
		return new Promise<T>((resolve, reject) => {
			const job: Job = { id: this.nextId++, task, resolve: (value) => resolve(value as T), reject,
				background: task.kind === 'materialize' || task.kind === 'playout', queuedAt: performance.now(), ...callbacks };
			const abort = (): void => {
				const index = this.queue.indexOf(job);
				if (index !== -1) {
					this.queue.splice(index, 1);
					job.cleanup?.();
					reject(new DOMException('Request cancelled', 'AbortError'));
				}
			};
			job.cleanup = () => signal?.removeEventListener('abort', abort);
			this.queue.push(job);
			signal?.addEventListener('abort', abort, { once: true });
			if (signal?.aborted) {
				abort();
			}
			this.dispatch();
		});
	}

	/** Reject queued work and terminate every scheduling worker. */
	async close(): Promise<void> {
		this.closing = true;
		const error = new Error('Scheduling workers shut down before completing the request');
		this.queue.splice(0).forEach((job) => {
			job.cleanup?.();
			job.reject(error);
		});
		for (const slot of this.slots) {
			slot.job?.finish?.();
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
		const worker = new Worker(this.workerUrl, {
			execArgv: this.workerExecArgv,
			workerData: { databasePath: this.previewContext?.db.$client.name },
		});
		const slot: WorkerSlot = { worker, job: null, catalogKey: null };
		this.slots.push(slot);
		worker.on(
			'message',
			(message: {
				id: number;
				result?: unknown;
				error?: SchedulingWorkerErrorPayload;
				write?: MaterializationWrite;
				event?: LiveEventInput;
				writeId?: number;
				timings?: JobTimings;
			}) => {
				const job = slot.job;
				if (!job || job.id !== message.id) {
					return;
				}

				if (message.event) {
					job.event?.(message.event);
					return;
				}
				if (message.write) {
					void Promise.resolve().then(async () => {
						const finish = this.previewContext?.responsiveness?.begin(`timeline.${message.write!.kind}`);
						try {
							await job.write!(message.write!);
						}
						finally {
							finish?.();
						}
					}).then(() => {
						worker.postMessage({ kind: 'write-result', writeId: message.writeId });
					}, (error: Error) => {
						worker.postMessage({ kind: 'write-result', writeId: message.writeId,
							error: { name: error instanceof StaleSemanticDecisionError ? 'StaleSemanticDecisionError' : error.name, message: error.message } });
					});
					return;
				}
				for (const [phase, duration] of Object.entries(message.timings ?? {})) {
					this.previewContext?.responsiveness?.record(`worker.${job.task.kind}.${phase}`, duration);
				}
				job.finish?.();
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
			slot.job?.finish?.();
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

			const backgroundAllowed = this.workerCount === 1
				|| this.slots.filter(entry => entry.job?.background).length < this.workerCount - 1;
			const interactive = this.queue.findIndex(entry => !entry.background);
			const background = backgroundAllowed ? this.queue.findIndex(entry => entry.background) : -1;
			const index = background !== -1 && (interactive === -1 || this.interactiveStreak >= 3) ? background : interactive;
			const job = index === -1 ? undefined : this.queue.splice(index, 1)[0];
			if (!job) {
				return;
			}

			job.cleanup?.();
			this.previewContext?.responsiveness?.record(`worker.${job.task.kind}.queue`, performance.now() - job.queuedAt);
			job.finish = this.previewContext?.responsiveness?.begin(`worker.${job.task.kind}`);
			this.interactiveStreak = job.background ? 0 : this.interactiveStreak + 1;
			slot.job = job;
			if (job.task.kind === 'read' || job.task.kind === 'materialize' || job.task.kind === 'playout') {
				slot.worker.postMessage({ id: job.id, kind: job.task.kind, input: job.task.input });
				continue;
			}
			if (job.task.kind === 'preview') {
				slot.worker.postMessage({ id: job.id, kind: 'preview', input: job.task.input });
				continue;
			}

			const input = job.task.input;
			const catalogKey = input.catalog.cacheKey ?? null;
			const reuseCatalog = Boolean(catalogKey && slot.catalogKey === catalogKey);
			slot.worker.postMessage({
				id: job.id,
				kind: 'generate',
				catalogKey,
				input: reuseCatalog ? { ...input, catalog: undefined } : input,
			});
			if (!reuseCatalog) {
				slot.catalogKey = catalogKey;
			}
		}
	}
}
