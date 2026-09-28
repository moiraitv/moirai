import { AiSelectionError } from './errors.js';
import type { AiGeneration, AiGenerationRequest, AiContentSelectionResponse } from '@moirai/shared';
import type { AiRequestActivity } from './provider.js';

/** Completed results remain reconnectable for one hour without unbounded retention. */
export const AI_GENERATION_RETENTION_MS = 60 * 60 * 1000;
/** Bound retained results and concurrent paid work on this server. */
export const AI_GENERATION_CAPACITY = 32;
/** One administrator may run at most two generations concurrently. */
export const AI_GENERATION_CONCURRENCY = 2;
/** A cancel that beats job creation blocks that id long enough for the late request to arrive. */
export const AI_GENERATION_CANCEL_GRACE_MS = 10 * 60 * 1000;
/** Bound remembered cancellations so unused client ids cannot grow without limit. */
const AI_GENERATION_CANCEL_LIMIT = 128;
/** Private ownership and cancellation attached to a public generation snapshot. */
interface GenerationRecord {
	owner: string;
	request: AiGenerationRequest;
	value: AiGeneration;
	controller: AbortController;
	expiresAt: number;
}

/** Safe errors for reconnect, ownership, and capacity failures. */
function generationError(message: string, statusCode: number): Error {
	return Object.assign(new Error(message), { statusCode, expose: true });
}

/**
 * Own bounded in-process jobs independently of HTTP connections. Results survive browser reloads,
 * remain private to their administrator, and expire after completion; shutdown cancels paid work.
 * A cancellation that arrives before creation blocks that id, and request-scoped selection shares the same cap.
 */
export class AiGenerations {
	private readonly records = new Map<string, GenerationRecord>();
	private readonly cancellations = new Map<string, { owner: string; expiresAt: number }>();
	private leases = 0;
	private readonly leasesByOwner = new Map<string, number>();

	/** Drop expired terminal records and cancellations; running jobs have their own deadline. */
	private prune(): void {
		for (const [id, record] of this.records) {
			if (record.value.state !== 'running' && record.expiresAt <= Date.now()) {
				this.records.delete(id);
			}
		}
		for (const [id, cancellation] of this.cancellations) {
			if (cancellation.expiresAt <= Date.now()) {
				this.cancellations.delete(id);
			}
		}
	}

	/** Count running jobs and request-scoped leases for one administrator. */
	private runningCount(owner: string): number {
		let count = this.leasesByOwner.get(owner) ?? 0;
		for (const record of this.records.values()) {
			if (record.owner === owner && record.value.state === 'running') {
				count += 1;
			}
		}
		return count;
	}

	/** Reject work that would exceed retained-job or per-administrator concurrency limits. */
	private assertCapacity(owner: string): void {
		if (this.records.size + this.leases >= AI_GENERATION_CAPACITY || this.runningCount(owner) >= AI_GENERATION_CONCURRENCY) {
			throw generationError('Generation capacity reached. Wait for a current generation to finish and try again.', 503);
		}
	}

	/** Remember a cancel that arrived before the job, so the matching start cannot begin paid work. */
	private rememberCancellation(owner: string, id: string): void {
		while (this.cancellations.size >= AI_GENERATION_CANCEL_LIMIT) {
			const oldest = this.cancellations.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.cancellations.delete(oldest);
		}
		this.cancellations.set(id, { owner, expiresAt: Date.now() + AI_GENERATION_CANCEL_GRACE_MS });
	}

	/** Return a private snapshot only to its creator. */
	get(owner: string, id: string): AiGeneration {
		this.prune();
		const record = this.records.get(id);
		if (!record || record.owner !== owner) {
			throw generationError('Generation expired or the server restarted. Generate again.', 404);
		}
		return record.value;
	}

	/** Start once per ID, retaining failures and successes for reconnecting clients. */
	start(
		owner: string,
		request: AiGenerationRequest,
		run: (activity: AiRequestActivity) => Promise<AiContentSelectionResponse>,
	): AiGeneration {
		this.prune();
		const existing = this.records.get(request.id);
		if (existing) {
			if (existing.owner !== owner || existing.request.libraryId !== request.libraryId || existing.request.prompt !== request.prompt
				|| existing.request.maxResults !== request.maxResults) {
				throw generationError('Generation identity is already in use.', 409);
			}
			return existing.value;
		}
		const cancellation = this.cancellations.get(request.id);
		if (cancellation && cancellation.expiresAt > Date.now()) {
			throw generationError(cancellation.owner === owner ? 'Generation cancelled.' : 'Generation identity is already in use.', 409);
		}
		this.assertCapacity(owner);
		const record: GenerationRecord = { owner, request, controller: new AbortController(), expiresAt: Infinity,
			value: { id: request.id, startedAt: Date.now(), state: 'running', status: 'preparing' } };
		this.records.set(request.id, record);
		void Promise.resolve().then(() => {
			record.controller.signal.throwIfAborted();
			return run({ signal: record.controller.signal, onProgress: (status, details) => {
				if (record.value.state === 'running') {
					record.value = { id: request.id, startedAt: record.value.startedAt, state: 'running', status, ...details };
				}
			} });
		}).then(result => {
			if (!record.controller.signal.aborted) {
				record.value = { ...record.value, state: 'completed', result };
			}
		}).catch(cause => {
			if (!record.controller.signal.aborted) {
				record.value = { ...record.value, state: 'failed', message: cause instanceof AiSelectionError ? cause.message : 'Generation failed or timed out. Try again.' };
			}
		}).finally(() => {
			record.expiresAt = Date.now() + AI_GENERATION_RETENTION_MS;
		});
		return record.value;
	}

	/** Cancel a discarded draft and release its retained result without accepting late completion. */
	cancel(owner: string, id: string): void {
		this.prune();
		const record = this.records.get(id);
		if (!record || record.owner !== owner) {
			if (!record) {
				this.rememberCancellation(owner, id);
			}
			throw generationError('Generation expired or the server restarted. Generate again.', 404);
		}
		record.controller.abort();
		this.records.delete(id);
		this.rememberCancellation(owner, id);
	}

	/** Hold one concurrency slot for request-scoped selection that is not a retained job. */
	acquire(owner: string): () => void {
		this.prune();
		this.assertCapacity(owner);
		this.leases += 1;
		this.leasesByOwner.set(owner, (this.leasesByOwner.get(owner) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.leases = Math.max(0, this.leases - 1);
			const count = this.leasesByOwner.get(owner) ?? 0;
			if (count <= 1) {
				this.leasesByOwner.delete(owner);
			}
			else {
				this.leasesByOwner.set(owner, count - 1);
			}
		};
	}

	/** Stop in-flight upstream work during server shutdown. */
	close(): void {
		for (const record of this.records.values()) {
			record.controller.abort();
		}
		this.records.clear();
		this.cancellations.clear();
		this.leases = 0;
		this.leasesByOwner.clear();
	}
}
