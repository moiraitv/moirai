import { existsSync } from 'node:fs';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import type { LiveEvent } from '@moirai/shared';
import type { LiveEventPublisher } from '../operations/live-events.js';
import type { EmbeddingInput, SemanticRepository } from '../repository/semantic.js';

/** Maximum media inferences before checking for interactive refinement work. */
export const MEDIA_EMBEDDING_BATCH_SIZE = 20;

/**
 * Own local inference in a child process, releasing it after idle or under resource pressure.
 * Process isolation allows the native ONNX runtime to reload safely after retirement.
 */
export class EmbeddingService {
	private worker: ChildProcess | null = null;
	private active: Promise<void> | null = null;
	private timer: NodeJS.Timeout | null = null;
	private idleTimer: NodeJS.Timeout | null = null;
	private closed = true;
	private paused = false;
	private dirty = true;
	private retryDelay = 2_000;

	constructor(
		private readonly repository: SemanticRepository,
		private readonly events: LiveEventPublisher,
		private readonly modelPath: string,
	) {}

	/** Start resumable background backfill without blocking server readiness. */
	start(): void {
		this.closed = false;
		this.kick();
	}

	/** Schedule reconciliation after catalog edits, including ancestor metadata changes. */
	handleEvent(event: LiveEvent): void {
		if (event.type === 'scan.changed' || event.type === 'library.changed' || event.type === 'scheduling.changed') {
			this.dirty = true;
			this.retryDelay = 2_000;
			if (this.timer) {
				clearTimeout(this.timer);
				this.timer = null;
			}
			this.kick();
		}
	}

	/** Wake pending draft inference without publishing progress before work begins. */
	requestPreferences(includeMedia = false): void {
		this.dirty ||= includeMedia;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.retryDelay = 250;
		this.kick();
	}

	/** Debounce event bursts and retry missing model bundles without busy looping. */
	private kick(): void {
		if (this.closed || this.paused || this.timer || this.active) {
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			this.retryDelay = 60_000;
			this.active = this.run().catch(() => {
				this.dirty = true;
				if (!this.closed && !this.paused) {
					this.repository.preparationError('model-unavailable');
					this.events.publish({ type: 'embeddings.changed', data: { pending: this.repository.catalog().pendingItemIds.length, failed: 0, status: 'idle' } });
				}
			}).finally(() => {
				this.active = null;
				this.kick();
			});
		}, this.retryDelay);
		this.timer.unref();
	}

	/** Run pending inference serially, yielding between items and publishing bounded progress. */
	private async run(): Promise<void> {
		if (this.closed || this.paused) {
			return;
		}
		if (this.dirty) {
			this.repository.preferences.reconcile();
		}
		const preferences = this.repository.preferences.pending();
		const pending = this.dirty ? this.repository.reconcile() : [];
		if (pending.length === 0 && preferences.length === 0) {
			this.dirty = false;
			return;
		}
		if (!existsSync(path.join(this.modelPath, 'onnx/model.onnx'))) {
			this.repository.preparationError('model-missing');
			this.events.publish({ type: 'embeddings.changed', data: { pending: pending.length + preferences.length, failed: 0, status: 'model-missing' } });
			return;
		}
		this.repository.preparationError(null);
		this.dirty = false;
		await this.preparePreferences(preferences, pending.length);

		// Alternate bounded batches so editor requests and library backfill both make progress.
		const results: Array<{ input: EmbeddingInput; vector: number[] | null }> = [];
		let failed = 0;
		for (let index = 0; index < pending.length; index += 1) {
			if (this.closed || this.paused) {
				this.dirty = true;
				break;
			}
			const input = pending[index]!;
			const vector = await this.infer(input.text, true);
			if (!vector) {
				failed += 1;
			}
			results.push({ input, vector });
			if (results.length >= MEDIA_EMBEDDING_BATCH_SIZE || index === pending.length - 1) {
				this.repository.storeBatch(results.splice(0));
				this.events.publish({ type: 'embeddings.changed', data: {
					pending: pending.length - index - 1, failed, status: index === pending.length - 1 ? 'idle' : 'working',
				} });
				await this.preparePreferences(this.repository.preferences.pending(), pending.length - index - 1);
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	/** Prepare one bounded refinement batch before allowing media backfill to continue. */
	private async preparePreferences(preferences: Array<{ hash: string; text: string }>, mediaRemaining: number): Promise<void> {
		for (const preference of preferences) {
			if (this.closed || this.paused) {
				return;
			}
			this.repository.preferences.store(preference.hash, await this.infer(preference.text));
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (preferences.length) {
			const remaining = this.repository.preferences.pending().length;
			if (remaining) {
				this.retryDelay = 250;
			}
			const pending = remaining + mediaRemaining;
			this.events.publish({ type: 'embeddings.changed', data: { pending, failed: 0, status: pending ? 'working' : 'idle' } });
		}
	}

	/** Send one bounded request; worker initialization failures leave jobs pending for retry. */
	private infer(text: string, media = false): Promise<number[] | null> {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
		}
		if (!this.worker) {
			const compiled = new URL('./embedding-worker.js', import.meta.url);
			const url = existsSync(compiled) ? compiled : new URL('./worker.ts', import.meta.url);
			this.worker = fork(url, [this.modelPath], {
				stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
				execArgv: url.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [],
			});
			const worker = this.worker;
			worker.on('error', () => {
				if (this.worker === worker) {
					this.worker = null;
				}
				this.dirty = true;
			});
			worker.on('exit', () => {
				if (this.worker === worker) {
					this.worker = null;
				}
			});
		}
		const worker = this.worker;
		return new Promise((resolve, reject) => {
			let finished = false;
			const finish = (error: Error | null, vector: number[] | null): void => {
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(timeout);
				worker.off('message', message);
				worker.off('error', failure);
				worker.off('exit', exit);
				this.idleTimer = setTimeout(() => {
					void this.retire();
				}, 60_000);
				this.idleTimer.unref();
				if (error) {
					void this.retire();
					reject(error);
				}
				else {
					resolve(vector);
				}
			};
			const message = (result: { vector?: number[] }): void => finish(null, result.vector ?? null);
			const failure = (error: Error): void => finish(error, null);
			const exit = (): void => finish(new Error('Embedding worker stopped'), null);
			const timeout = setTimeout(() => finish(new Error('Embedding inference timed out'), null), 60_000);
			worker.once('message', message);
			worker.once('error', failure);
			worker.once('exit', exit);
			worker.send(media ? { text, media } : text, (error) => {
				if (error) {
					failure(error);
				}
			});
		});
	}

	/** Release native inference resources rather than retaining the model indefinitely. */
	private async retire(): Promise<void> {
		const worker = this.worker;
		this.worker = null;
		if (worker && worker.exitCode === null && worker.signalCode === null) {
			await new Promise<void>((resolve) => {
				worker.once('exit', () => resolve());
				worker.kill('SIGKILL');
			});
		}
	}

	/** Suspend optional inference under playback resource pressure. */
	async suspend(): Promise<void> {
		this.paused = true;
		await this.retire();
	}

	/** Resume unfinished backfill after pressure recovery. */
	resume(): void {
		this.paused = false;
		this.dirty = true;
		this.kick();
	}

	/** Cancel timers and join in-flight inference before SQLite closes. */
	async close(): Promise<void> {
		this.closed = true;
		if (this.timer) {
			clearTimeout(this.timer);
		}
		await this.retire();
		await this.active;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
		}
	}
}
