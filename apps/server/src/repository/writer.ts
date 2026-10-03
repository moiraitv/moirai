import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { writeError, type WriteError } from './write-errors.js';
import type { ResponsivenessMonitor } from '../operations/responsiveness.js';
import { WRITE_METHODS, writeDomain, type WriteCommand, type WriteDomains, type WriteResult } from './write-commands.js';
import type { Repository } from './index.js';

/** Bound accepted waiting writes without increasing the application's read-worker capacity. */
export const DATABASE_WRITE_QUEUE_LIMIT = 32;

/** Report backpressure before a mutation has been accepted by the write owner. */
export class DatabaseWriteQueueFullError extends Error {
	readonly statusCode = 503;
	constructor() {
		super('Database write queue is full');
	}
}

/** One accepted command, retained until its commit or rollback acknowledgement arrives. */
interface PendingWrite {
	id: number;
	command: WriteCommand;
	acceptedAt: number;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/** Own all runtime writes on one thread; never replay an uncertain mutation after failure. */
export class DatabaseWriter {
	private readonly worker: Worker;
	private readonly queue: PendingWrite[] = [];
	private active: PendingWrite | null = null;
	private nextId = 1;
	private closing = false;
	private failed: Error | null = null;
	private readonly capacityWaiters = new Set<() => void>();
	private drain: (() => void) | null = null;

	constructor(databasePath: string, private readonly responsiveness?: ResponsivenessMonitor) {
		const compiled = new URL('./writer.worker.js', import.meta.url);
		const source = new URL('./writer.worker.ts', import.meta.url);
		this.worker = new Worker(existsSync(compiled) ? compiled : source, {
			workerData: { databasePath },
			execArgv: existsSync(compiled) ? process.execArgv : ['--import', 'tsx'],
		});
		this.worker.on('message', (message: { id: number; result?: unknown; error?: WriteError; databaseMs?: number }) => {
			const active = this.active;
			if (!active || message.id !== active.id) {
				return;
			}
			this.active = null;
			if (message.databaseMs !== undefined) {
				this.responsiveness?.record('database.write', message.databaseMs);
			}
			if (message.error) {
				const error = writeError(message.error);
				active.reject(error);
			}
			else {
				active.resolve(message.result);
			}
			this.dispatch();
		});
		this.worker.on('error', error => this.fail(error));
		this.worker.on('exit', code => {
			if (!this.closing || this.active || this.queue.length) {
				this.fail(new Error(`Database writer exited (${code})`));
			}
		});
	}

	/** Fail readiness after an uncertain worker exit or while shutdown is draining writes. */
	checkReady(): void {
		if (this.failed || this.closing) {
			throw this.failed ?? new Error('Database writer is closing');
		}
	}

	/** Accept one typed mutation; a full queue rejects before any write is dispatched. */
	async execute<C extends WriteCommand>(command: C, backpressure = false): Promise<WriteResult<C>> {
		while (backpressure && !this.closing && !this.failed && this.queue.length >= DATABASE_WRITE_QUEUE_LIMIT) {
			await new Promise<void>(resolve => this.capacityWaiters.add(resolve));
		}
		if (this.failed || this.closing) {
			return Promise.reject(this.failed ?? new Error('Database writer is closing'));
		}
		if (this.queue.length >= DATABASE_WRITE_QUEUE_LIMIT) {
			return Promise.reject(new DatabaseWriteQueueFullError());
		}
		return new Promise<unknown>((resolve, reject) => {
			const started = performance.now();
			const payload = structuredClone(command);
			this.responsiveness?.record('database.serialize', performance.now() - started);
			this.queue.push({ id: this.nextId++, command: payload, acceptedAt: performance.now(), resolve, reject });
			this.dispatch();
		}).then(result => result as WriteResult<C>);
	}

	/** Wait for previously accepted transactions before retiring the write connection. */
	async close(): Promise<void> {
		this.closing = true;
		this.releaseCapacity();
		if (this.active || this.queue.length) {
			await new Promise<void>(resolve => {
				this.drain = resolve; 
			});
		}
		await this.worker.terminate();
	}

	/** Dispatch exactly one transaction at a time in acceptance order. */
	private dispatch(): void {
		if (!this.active) {
			this.active = this.queue.shift() ?? null;
			if (this.active) {
				this.releaseCapacity();
				this.responsiveness?.record('database.queue', performance.now() - this.active.acceptedAt);
				const started = performance.now();
				try {
					this.worker.postMessage({ id: this.active.id, command: this.active.command });
				}
				catch (error) {
					this.active.reject(error as Error);
					this.active = null;
					this.dispatch();
				}
				this.responsiveness?.record('database.transfer', performance.now() - started);
			}
			else {
				this.drain?.();
			}
		}
	}

	/** Wake bounded background producers when acceptance capacity or shutdown changes. */
	private releaseCapacity(): void {
		for (const resolve of this.capacityWaiters) {
			resolve();
		}
		this.capacityWaiters.clear();
	}

	/** Fail every waiter without retrying a command whose outcome may be unknown. */
	private fail(error: Error): void {
		this.failed = error;
		this.releaseCapacity();
		this.active?.reject(error);
		this.active = null;
		for (const entry of this.queue.splice(0)) {
			entry.reject(error);
		}
		this.drain?.();
	}
}

/**
 * Adapt the local facade to runtime ownership. Callers await every mutation, including methods
 * that are synchronous on a standalone repository; reads retain their existing contracts.
 */
export function writerRepository(repository: Repository, writer: DatabaseWriter): Repository {
	const wrap = (domain: keyof WriteDomains): object => {
		const owner = writeDomain(repository, domain);
		return new Proxy(owner, {
			get(target, property) {
				if (typeof property === 'string' && (WRITE_METHODS[domain] as readonly string[]).includes(property)) {
					return async (...args: unknown[]) => {
						if (domain === 'preferences' && property === 'catalog' && args[1] === false) {
							return Reflect.get(target, property).apply(target, args);
						}
						const result = await writer.execute(
							{ domain, method: property, args } as WriteCommand,
							domain === 'semantic' || domain === 'preferences' || (domain === 'root'
								&& ['recoverInterruptedScans', 'beginScan', 'reconcileScan', 'applyMissingItemPresence', 'failScan', 'cancelScan', 'pruneScanHistory', 'markTimelinePending', 'markTimelineFailed', 'commitMaterializedTimeline', 'recordViewingPreference', 'pruneViewingPreferences', 'setWatcherStatus', 'markChangeDetected'].includes(property)),
						);
						if (domain === 'semantic' || domain === 'preferences' || domain === 'fillerPresets'
							|| domain === 'midRollPresets' || (domain === 'root'
								&& !['recordViewingPreference', 'clearViewingPreferences', 'pruneViewingPreferences', 'pruneScanHistory', 'markTimelinePending', 'markTimelineFailed', 'beginScan', 'cancelScan', 'failScan', 'setWatcherStatus'].includes(property))) {
							repository.invalidateSchedulingCatalog();
						}
						return result;
					};
				}
				if (domain === 'root' && typeof property === 'string' && property in WRITE_METHODS) {
					return wrap(property as keyof WriteDomains);
				}
				if (domain === 'semantic' && property === 'preferences') {
					return wrap('preferences');
				}
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	};
	return wrap('root') as Repository;
}
