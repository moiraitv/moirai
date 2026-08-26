import { openSync, closeSync } from 'node:fs';
import { devNull } from 'node:os';
import type { Logger } from 'pino';
import { currentTimestamp } from '../time.js';

/** OS error codes that indicate process or kernel resource exhaustion. */
const RESOURCE_ERROR_CODES = new Set(['EMFILE', 'ENFILE', 'ENOSPC']);
/** Descriptors held only so pressure recovery can always make immediate progress. */
const EMERGENCY_DESCRIPTOR_COUNT = 12;
/** Quiet period before optional background work may resume. */
const RECOVERY_COOLDOWN_MS = 30_000;

/** Optional persistent work that can release capacity for essential operations. */
export interface ResourcePressureShedder {
	name: string;
	stage: 'background' | 'connections';
	suspend(): Promise<void> | void;
	recover?(): Promise<void> | void;
}

/** Current process resource-pressure state exposed through readiness. */
export interface ResourcePressureHealth {
	status: 'ready' | 'degraded' | 'stopping';
	detail?: string;
}

/** Return the stable OS resource code carried by an error or its cause chain. */
export function resourceErrorCode(error: unknown): string | null {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current; depth += 1) {
		const code = (current as NodeJS.ErrnoException).code;
		if (typeof code === 'string' && RESOURCE_ERROR_CODES.has(code)) {
			return code;
		}

		current = (current as Error & { cause?: unknown }).cause;
	}
	return null;
}

/**
 * Protect essential operations when the process exhausts descriptors or storage capacity. The
 * coordinator maintains an emergency reserve, serializes staged shedding, retries bounded work, and
 * restores optional services after a quiet recovery period.
 */
export class ResourcePressureCoordinator {
	private readonly shedders = new Set<ResourcePressureShedder>();
	private reserve: number[] = [];
	private pressure: Promise<void> | null = null;
	private readonly shedStages = new Set<ResourcePressureShedder['stage']>();
	private recoveryTimer: NodeJS.Timeout | null = null;
	private degradedSince: string | null = null;
	private closing = false;

	constructor(private readonly logger?: Pick<Logger, 'warn' | 'info'>) {
		this.restoreReserve();
	}

	/** Register optional work and return a function that removes its ownership. */
	register(shedder: ResourcePressureShedder): () => void {
		this.shedders.add(shedder);
		return () => this.shedders.delete(shedder);
	}

	/** Run essential work, shedding optional capacity and retrying resource failures. */
	async runEssential<T>(operation: string, work: () => Promise<T>): Promise<T> {
		try {
			const result = await work();
			this.noteSuccess();
			return result;
		}
		catch (error) {
			const code = resourceErrorCode(error);
			if (!code || this.closing) {
				throw error;
			}

			await this.relieve(operation, code, 'background');
		}

		try {
			const result = await work();
			this.noteSuccess();
			return result;
		}
		catch (error) {
			const code = resourceErrorCode(error);
			if (!code || this.closing) {
				throw error;
			}

			await this.relieve(operation, code, 'connections');
			const result = await work();
			this.noteSuccess();
			return result;
		}
	}

	/** Release optional capacity after a resource error outside an essential wrapper. */
	async report(error: unknown, operation: string): Promise<boolean> {
		const code = resourceErrorCode(error);
		if (!code || this.closing) {
			return false;
		}

		await this.relieve(operation, code, 'background');
		return true;
	}

	/** Return current pressure state without performing resource probes. */
	health(): ResourcePressureHealth {
		if (this.closing) {
			return { status: 'stopping' };
		}

		return this.degradedSince
			? { status: 'degraded', detail: `Optional services reduced since ${this.degradedSince}` }
			: { status: 'ready' };
	}

	/** Release the emergency reserve and stop future recovery. */
	async close(): Promise<void> {
		this.closing = true;
		if (this.recoveryTimer) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = null;
		}
		this.releaseReserve();
	}

	/** Serialize one shedding stage so concurrent failures cannot create a retry storm. */
	private async relieve(
		operation: string,
		code: string,
		stage: ResourcePressureShedder['stage'],
	): Promise<void> {
		if (this.shedStages.has(stage)) {
			await this.pressure;
			return;
		}

		this.shedStages.add(stage);
		const previous = this.pressure ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(async () => {
			this.degradedSince ??= currentTimestamp();
			this.releaseReserve();
			this.logger?.warn(
				{ code, operation, stage },
				'System resource pressure detected; reducing optional services',
			);
			await Promise.allSettled(
				[...this.shedders]
					.filter((shedder) => shedder.stage === stage)
					.map((shedder) => Promise.resolve().then(() => shedder.suspend())),
			);
		});
		const tracked = current.finally(() => {
			if (this.pressure === tracked) {
				this.pressure = null;
			}
		});
		this.pressure = tracked;
		await current;
	}

	/** Schedule gradual recovery after an essential operation succeeds. */
	private noteSuccess(): void {
		if (!this.degradedSince || this.recoveryTimer || this.closing) {
			return;
		}

		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = null;
			void this.recover();
		}, RECOVERY_COOLDOWN_MS);
		this.recoveryTimer.unref();
	}

	/** Restore lightweight services after a quiet period; watchers manage their own backoff. */
	private async recover(): Promise<void> {
		if (this.closing) {
			return;
		}

		for (const shedder of this.shedders) {
			if (shedder.recover) {
				await Promise.resolve(shedder.recover()).catch(() => undefined);
			}
		}
		this.restoreReserve();
		this.shedStages.clear();
		this.degradedSince = null;
		this.logger?.info('Optional services resumed after resource pressure');
	}

	/** Open emergency descriptors until the bounded reserve is full. */
	private restoreReserve(): void {
		while (!this.closing && this.reserve.length < EMERGENCY_DESCRIPTOR_COUNT) {
			try {
				this.reserve.push(openSync(devNull, 'r'));
			}
			catch {
				break;
			}
		}
	}

	/** Close every emergency descriptor immediately. */
	private releaseReserve(): void {
		for (const descriptor of this.reserve.splice(0)) {
			try {
				closeSync(descriptor);
			}
			catch {
				// The descriptor may already have been reclaimed during shutdown.
			}
		}
	}
}
