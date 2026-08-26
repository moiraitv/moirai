import type { Logger } from 'pino';
import type { ArtworkCache } from '../artwork/artwork-cache.js';
import type { AppConfig } from '../config.js';
import type { LogService } from './log-service.js';
import type { Repository } from '../repository/index.js';

/** Delay between background retention and orphan-cleanup passes. */
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Periodically prune bounded operational data without adding work to normal requests. The service
 * coalesces scheduled and manual passes across scan history, retained logs, and orphaned artwork, and
 * reports whether the latest pass succeeded.
 */
export class MaintenanceService {
	private timer: NodeJS.Timeout | null = null;
	private active: Promise<void> | null = null;
	private running = false;
	private lastRunFailed = false;

	constructor(
		private readonly repository: Repository,
		private readonly artworkCache: ArtworkCache,
		private readonly logs: LogService,
		private readonly config: AppConfig,
		private readonly logger: Logger,
	) {}

	/** Start periodic database and cache maintenance. */
	start(): void {
		if (this.running) {
			return;
		}

		this.running = true;
		void this.runNow()
			.catch((error) => this.logger.error({ err: error }, 'Operational maintenance failed'))
			.finally(() => this.schedule());
	}

	/** Run maintenance now, sharing one active pass across concurrent callers. */
	async runNow(): Promise<void> {
		if (this.active) {
			return this.active;
		}

		this.active = this.run();
		try {
			await this.active;
			this.lastRunFailed = false;
		}
		catch (error) {
			this.lastRunFailed = true;
			throw error;
		}
		finally {
			this.active = null;
		}
	}

	/** Return whether scheduled maintenance is running without a failed latest pass. */
	health(): { status: 'ready' | 'degraded'; detail?: string } {
		if (!this.running) {
			return { status: 'degraded', detail: 'Operational maintenance is not running' };
		}

		return this.lastRunFailed
			? { status: 'degraded', detail: 'The latest operational maintenance pass failed' }
			: { status: 'ready' };
	}

	/** Stop scheduled maintenance and wait for active work to settle. */
	async close(): Promise<void> {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		await this.active?.catch(() => undefined);
	}

	/** Perform one bounded background maintenance pass. */
	private async run(): Promise<void> {
		this.repository.pruneScanHistory({
			scanDays: this.config.scanHistoryRetentionDays,
			scansPerLibrary: this.config.scanHistoryMaxPerLibrary,
		});
		await this.logs.prune();
		await this.artworkCache.pruneOrphans((libraryId, kind, ids) =>
			this.repository.existingArtworkOwnerIds(libraryId, kind, ids));
	}

	/** Schedule the next maintenance pass if one is not already queued. */
	private schedule(): void {
		if (!this.running) {
			return;
		}

		this.timer = setTimeout(() => {
			this.timer = null;
			void this.runNow()
				.catch((error) => this.logger.error({ err: error }, 'Operational maintenance failed'))
				.finally(() => this.schedule());
		}, MAINTENANCE_INTERVAL_MS);
		this.timer.unref();
	}
}
