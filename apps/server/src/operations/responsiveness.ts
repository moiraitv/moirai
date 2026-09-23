import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Logger } from 'pino';

/** Small event-loop stalls affect interaction well before the Docker health timeout. */
const STALL_WARNING_MS = 250;
/** Rate-limit recurring pressure reports. */
const WARNING_INTERVAL_MS = 30_000;

/**
 * Observe server stalls without recording payloads or private resource identifiers. Operation labels
 * identify concurrent work, while bounded timing summaries distinguish execution from queue delay.
 */
export class ResponsivenessMonitor {
	private readonly histogram = monitorEventLoopDelay({ resolution: 20 });
	private readonly active = new Map<string, number>();
	private readonly recent = new Set<string>();
	private readonly timer: NodeJS.Timeout;
	private lastWarning = 0;

	constructor(private readonly logger: Logger) {
		this.histogram.enable();
		this.timer = setInterval(() => this.sample(), 1_000);
		this.timer.unref();
	}

	/** Start one named phase and return an idempotent timing completion callback. */
	begin(operation: string): () => void {
		const started = performance.now();
		this.active.set(operation, (this.active.get(operation) ?? 0) + 1);
		this.recent.add(operation);
		let finished = false;
		return () => {
			if (finished) {
				return;
			}
			finished = true;
			const count = (this.active.get(operation) ?? 1) - 1;
			if (count === 0) {
				this.active.delete(operation);
			}
			else {
				this.active.set(operation, count);
			}
			this.logger.debug({ operation, durationMs: Math.round(performance.now() - started) }, 'Operation completed');
		};
	}

	/** Record a completed phase using fixed labels and no request contents. */
	record(operation: string, durationMs: number): void {
		this.logger.debug({ operation, durationMs: Math.round(durationMs) }, 'Operation completed');
	}

	/** Release sampling resources with the HTTP application. */
	close(): void {
		clearInterval(this.timer);
		this.histogram.disable();
	}

	/** Report substantial stalls at most once per warning interval. */
	private sample(): void {
		const delayMs = this.histogram.max / 1_000_000;
		if (delayMs >= STALL_WARNING_MS && Date.now() - this.lastWarning >= WARNING_INTERVAL_MS) {
			this.lastWarning = Date.now();
			this.logger.warn(
				{ eventLoopDelayMs: Math.round(delayMs), operations: [...new Set([...this.recent, ...this.active.keys()])] },
				'Server event loop was delayed',
			);
		}
		this.histogram.reset();
		this.recent.clear();
	}
}
