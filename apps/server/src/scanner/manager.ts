import type { ResponsivenessMonitor } from '../operations/responsiveness.js';
import type { Logger } from 'pino';
import {
	isSuppressedScanIssue,
	REMOVAL_CONFIRMATION_INTERVAL_MINUTES,
	WATCHER_INTEGRITY_SCAN_INTERVAL_MINUTES,
	type Library,
	type ScanProgress,
	type ScanRun,
} from '@moirai/shared';
import type { LiveEventPublisher } from '../operations/live-events.js';
import { Repository } from '../repository/index.js';
import type { ResourcePressureCoordinator } from '../operations/resource-pressure.js';
import type {
	LibrarySourceAdapter,
	ScanDiscovery,
	SourceConfigurationImpact,
	SourceWatcher,
} from './contracts.js';
import { LibrarySourceRegistry } from './source-registry.js';

/** Watcher, timer, scan queue, and cancellation state owned by one library. */
interface LibraryRuntime {
	watcher?: SourceWatcher;
	watcherDesired?: boolean;
	timer?: NodeJS.Timeout;
	integrityAnchorAt: number;
	presenceAttemptedAt?: number;
	debounce?: NodeJS.Timeout;
	watcherRetry?: NodeJS.Timeout;
	watcherRetryAttempts?: number;
}

/** Process-level scanner state used by readiness checks. */
export interface ScannerHealth {
	status: 'starting' | 'ready' | 'degraded' | 'stopping';
	detail?: string;
}

/**
 * Coordinate provider watchers, completion-relative integrity scans, lightweight missing-item
 * confirmation, and one coalesced cancellable full scan per library. The manager owns lifecycle,
 * retry, progress, cancellation, and publication of source changes that may affect programming.
 */
export class ScannerManager {
	/** Minimum delay between live progress events from the same scan. */
	private static readonly progressIntervalMs = 250;
	private readonly runtimes = new Map<string, LibraryRuntime>();
	private readonly libraryOperations = new Map<string, Promise<void>>();
	private readonly activeScans = new Map<string, Promise<ScanRun>>();
	private readonly scanControllers = new Map<string, AbortController>();
	private readonly activePresenceChecks = new Map<string, Promise<void>>();
	private readonly presenceControllers = new Map<string, AbortController>();
	private readonly queuedTriggers = new Map<string, ScanRun['trigger']>();
	private readonly stoppedLibraries = new Set<string>();
	private readonly lastProgress = new Map<string, ScanProgress>();
	private readonly lastProgressPublishedAt = new Map<string, number>();
	private closing = false;
	private started = false;
	private startupFailed = false;
	private closeDeadlineAt: number | null = null;

	constructor(
		private readonly repository: Repository,
		private readonly events: LiveEventPublisher,
		private readonly sources: LibrarySourceRegistry,
		private readonly cancellationGraceMs = 5_000,
		private readonly purgeRemovedArtwork?: (libraryId: string, itemIds: string[]) => Promise<void>,
		private readonly logger?: Pick<Logger, 'warn'>,
		private readonly resourcePressure?: ResourcePressureCoordinator,
		private readonly responsiveness?: ResponsivenessMonitor,
	) {}

	/** Source types available to library configuration and capability clients. */
	get sourceTypes(): string[] {
		return this.sources.sourceTypes;
	}

	/** Validate one library source definition through its registered adapter. */
	async validateSource(sourceType: string, config: unknown): Promise<void> {
		await this.sources.validate(sourceType, config);
	}

	/** Classify whether a source configuration change requires reindexing or identity review. */
	sourceConfigurationImpact(
		sourceType: string,
		previous: unknown,
		next: unknown,
	): SourceConfigurationImpact {
		return this.sources.configurationImpact(sourceType, previous, next);
	}

	/** Recover interrupted scans and start watchers for configured libraries. */
	async start(): Promise<void> {
		this.startupFailed = false;
		try {
			const recoveryLibraries = new Set(await this.repository.recoverInterruptedScans());
			for (const library of await this.repository.listLibraries()) {
				await this.refreshLibrary(library.id);
				const adapter = this.sources.require(library.sourceType);
				if (
					library.enabled
					&& (
						recoveryLibraries.has(library.id)
						|| (adapter.usesMediaProbeCache
							&& await this.repository.libraryNeedsMediaProbe(library.id))
					)
				) {
					this.launchScan(library.id, 'initial');
				}
			}
			this.started = true;
		}
		catch (error) {
			this.startupFailed = true;
			throw error;
		}
	}

	/** Return process-level scanner readiness without probing media sources. */
	health(): ScannerHealth {
		if (this.closing) {
			return { status: 'stopping', detail: 'Scanner shutdown is in progress' };
		}

		if (this.startupFailed) {
			return { status: 'degraded', detail: 'Scanner startup failed' };
		}

		return this.started ? { status: 'ready' } : { status: 'starting' };
	}

	/** Refresh library from current data in the library scan. */
	async refreshLibrary(libraryId: string): Promise<void> {
		this.stoppedLibraries.delete(libraryId);
		await this.runLibraryOperation(libraryId, async () => {
			await this.stopLibraryRuntime(libraryId);
			if (!this.closing) {
				await this.startLibraryRuntime(libraryId);
			}
		});
	}

	/** Start library runtime and acquire resources for the library scan. */
	private async startLibraryRuntime(libraryId: string): Promise<void> {
		const library = await this.repository.getLibraryScanTarget(libraryId);
		if (
			!library
			|| !library.enabled
			|| this.closing
			|| this.stoppedLibraries.has(libraryId)
		) {
			return;
		}
		let adapter: LibrarySourceAdapter;
		try {
			adapter = this.sources.require(library.sourceType);
		}
		catch {
			await this.setWatcherStatus(library.id, 'error');
			return;
		}

		const completedAt = library.lastScanCompletedAt
			? Date.parse(library.lastScanCompletedAt)
			: Number.NaN;
		const runtime: LibraryRuntime = {
			integrityAnchorAt: Number.isFinite(completedAt) ? completedAt : Date.now(),
		};
		runtime.watcherDesired = library.watcherEnabled && Boolean(adapter.createWatcher);
		this.runtimes.set(library.id, runtime);
		if (this.closing || this.stoppedLibraries.has(libraryId)) {
			await this.stopLibraryRuntime(libraryId);
			return;
		}

		if (runtime.watcherDesired) {
			await this.startSourceWatcher(library, runtime, adapter);
		}
		else {
			await this.setWatcherStatus(library.id, 'stopped');
		}
		await this.scheduleNextWork(library.id);
	}

	/** Request a library scan and surface its current status. */
	async scan(libraryId: string, trigger: ScanRun['trigger']): Promise<ScanRun> {
		if (this.stoppedLibraries.has(libraryId) || this.closing) {
			throw new Error('Library scanning has stopped');
		}

		const active = this.activeScans.get(libraryId);
		if (active) {
			if (trigger !== 'periodic') {
				this.queuedTriggers.set(libraryId, trigger);
			}
			return active;
		}

		const controller = new AbortController();
		this.scanControllers.set(libraryId, controller);
		const operation = this.performScan(libraryId, trigger, controller.signal).finally(() => {
			this.activeScans.delete(libraryId);
			this.lastProgress.delete(libraryId);
			this.lastProgressPublishedAt.delete(libraryId);
			if (this.scanControllers.get(libraryId) === controller) {
				this.scanControllers.delete(libraryId);
			}
			const runtime = this.runtimes.get(libraryId);
			if (runtime) {
				runtime.integrityAnchorAt = Date.now();
				delete runtime.presenceAttemptedAt;
			}
			const queued = this.queuedTriggers.get(libraryId);
			if (queued && !this.stoppedLibraries.has(libraryId) && !this.closing) {
				this.queuedTriggers.delete(libraryId);
				this.launchScan(libraryId, queued);
			}
			else {
				void this.scheduleNextWork(libraryId).catch(() => undefined);
			}
		});
		this.activeScans.set(libraryId, operation);
		return operation;
	}

	/** Schedule the earliest integrity scan or targeted missing-item presence check. */
	private async scheduleNextWork(libraryId: string): Promise<void> {
		const runtime = this.runtimes.get(libraryId);
		if (!runtime || this.closing || this.stoppedLibraries.has(libraryId)) {
			return;
		}

		if (runtime.timer) {
			clearTimeout(runtime.timer);
			delete runtime.timer;
		}
		const library = await this.repository.getLibraryScanTarget(libraryId);
		if (!library?.enabled || this.runtimes.get(libraryId) !== runtime) {
			return;
		}

		const batch = await this.repository.getMissingItemPresenceBatch(libraryId);
		const integrityIntervalMinutes = runtime.watcher
			? WATCHER_INTEGRITY_SCAN_INTERVAL_MINUTES
			: library.scanIntervalMinutes;
		const integrityDueAt = runtime.integrityAnchorAt + integrityIntervalMinutes * 60_000;
		const attemptedPresenceDueAt = runtime.presenceAttemptedAt === undefined
			? 0
			: runtime.presenceAttemptedAt + REMOVAL_CONFIRMATION_INTERVAL_MINUTES * 60_000;
		const presenceDueAt = batch
			? Math.max(Date.parse(batch.nextCheckAt), attemptedPresenceDueAt)
			: Number.POSITIVE_INFINITY;
		const dueAt = Math.min(integrityDueAt, presenceDueAt);
		runtime.timer = setTimeout(() => {
			delete runtime.timer;
			void this.runScheduledWork(libraryId).catch(() => undefined);
		}, Math.max(0, dueAt - Date.now()));
		runtime.timer.unref();
	}

	/** Run due background work without queuing a periodic scan behind active work. */
	private async runScheduledWork(libraryId: string): Promise<void> {
		const runtime = this.runtimes.get(libraryId);
		if (!runtime || this.closing || this.stoppedLibraries.has(libraryId)) {
			return;
		}

		if (this.activeScans.has(libraryId) || this.activePresenceChecks.has(libraryId)) {
			return;
		}
		const library = await this.repository.getLibraryScanTarget(libraryId);
		if (!library?.enabled) {
			return;
		}

		const batch = await this.repository.getMissingItemPresenceBatch(libraryId);
		const integrityIntervalMinutes = runtime.watcher
			? WATCHER_INTEGRITY_SCAN_INTERVAL_MINUTES
			: library.scanIntervalMinutes;
		const integrityDueAt = runtime.integrityAnchorAt + integrityIntervalMinutes * 60_000;
		const attemptedPresenceDueAt = runtime.presenceAttemptedAt === undefined
			? 0
			: runtime.presenceAttemptedAt + REMOVAL_CONFIRMATION_INTERVAL_MINUTES * 60_000;
		const presenceDueAt = batch
			? Math.max(Date.parse(batch.nextCheckAt), attemptedPresenceDueAt)
			: Number.POSITIVE_INFINITY;
		const now = Date.now();
		if (Math.min(integrityDueAt, presenceDueAt) > now) {
			await this.scheduleNextWork(libraryId);
			return;
		}

		if (integrityDueAt <= presenceDueAt) {
			this.launchScan(libraryId, 'periodic');
			return;
		}

		this.launchPresenceCheck(libraryId);
	}

	/** Start one path-only missing-item check and contain asynchronous failures. */
	private launchPresenceCheck(libraryId: string): void {
		if (this.activePresenceChecks.has(libraryId)) {
			return;
		}

		const controller = new AbortController();
		this.presenceControllers.set(libraryId, controller);
		const runtime = this.runtimes.get(libraryId);
		if (runtime) {
			runtime.presenceAttemptedAt = Date.now();
		}
		const operation = this.performPresenceCheck(libraryId, controller.signal).finally(() => {
			this.activePresenceChecks.delete(libraryId);
			if (this.presenceControllers.get(libraryId) === controller) {
				this.presenceControllers.delete(libraryId);
			}
			if (!this.activeScans.has(libraryId)) {
				void this.scheduleNextWork(libraryId).catch(() => undefined);
			}
		});
		this.activePresenceChecks.set(libraryId, operation);
	}

	/** Reconcile only current tombstone paths without creating a scan-history record. */
	private async performPresenceCheck(libraryId: string, signal: AbortSignal): Promise<void> {
		const [library, batch] = await Promise.all([
			this.repository.getLibraryScanTarget(libraryId),
			this.repository.getMissingItemPresenceBatch(libraryId),
		]);
		if (!library || !batch) {
			return;
		}

		try {
			const adapter = this.sources.require(library.sourceType);
			if (!adapter.checkPresence) {
				this.launchScan(libraryId, 'periodic');
				return;
			}

			const checked = await adapter.checkPresence(library, batch.targets, { signal });
			signal.throwIfAborted();
			const reconciled = await this.repository.applyMissingItemPresence(
				libraryId,
				batch.revision,
				checked.sourceIdentity,
				checked.observations,
			);
			if (reconciled.removedItemIds.length > 0 && this.purgeRemovedArtwork) {
				await this.purgeRemovedArtwork(libraryId, reconciled.removedItemIds).catch(() => undefined);
			}
			if (reconciled.removedItemIds.length > 0 || reconciled.restoredItemIds.length > 0) {
				this.repository.invalidateSchedulingCatalog();
			}
			if (reconciled.changed) {
				this.events.publish({
					type: 'library.changed',
					data: {
						libraryId,
						change: 'reconciled',
						affectsProgramming: reconciled.removedItemIds.length > 0
							|| reconciled.restoredItemIds.length > 0,
					},
				});
			}

			const needsFullScan = !reconciled.applied
				|| (
					batch.mode === 'confirmation'
					&& (
						reconciled.presentItemIds.length > 0
						|| checked.observations.some((entry) => entry.status === 'inconclusive')
					)
				);
			if (needsFullScan) {
				this.launchScan(libraryId, 'watcher');
			}
		}
		catch (error) {
			if (!signal.aborted) {
				this.logger?.warn(
					{ libraryId, error },
					'Targeted missing-item presence check failed; starting a full scan',
				);
				this.launchScan(libraryId, 'periodic');
			}
		}
	}

	/** Run one discovery and reconciliation pass for a library. */
	private async performScan(
		libraryId: string,
		trigger: ScanRun['trigger'],
		signal: AbortSignal,
	): Promise<ScanRun> {
		// Load the effective source definition and publish initial progress.
		const library = await this.repository.getLibraryScanTarget(libraryId);
		if (!library) {
			throw new Error('Library not found');
		}

		const run = await this.repository.beginScan(libraryId, trigger);
		const sourceWasUnavailable = library.sourceAvailability !== 'available';
		this.publishScan(run, false, {
			phase: 'discovering',
			processedCount: 0,
			totalCount: null,
		});
		let discovery: ScanDiscovery;

		// Discover files and technical metadata without mutating the current index.
		try {
			const adapter = this.sources.require(library.sourceType);
			const probeCache = adapter.usesMediaProbeCache
				? new Map(
					((await this.repository.listMediaProbeCache?.(libraryId)) ?? [])
						.map((entry) => [entry.relativePath, entry]),
				)
				: new Map();
			discovery = await adapter.discover(library, {
				signal,
				probeCache,
				tailAssessments: await this.repository.listTailAssessments?.(libraryId),
				onProgress: (progress) => this.publishScanProgress(run, progress),
			});
		}
		catch (error) {
			if (signal.aborted) {
				const cancelled = await this.repository.cancelScan(run);
				this.publishScan(cancelled, false);
				return cancelled;
			}

			const failed = await this.repository.failScan(run, error, true);
			this.repository.invalidateSchedulingCatalog();
			this.publishScan(failed, true);
			return failed;
		}

		// Reconcile a successful discovery and purge artwork for confirmed removals.
		try {
			signal.throwIfAborted();
			const finish = this.responsiveness?.begin('scan.reconcile.write');
			const completed = await this.repository.reconcileScan(
				run,
				discovery.groups,
				discovery.items,
				discovery.issues,
				discovery.traversalComplete,
				discovery.sourceIdentity,
				discovery.conflicts,
			).finally(() => finish?.());
			if (completed.removedItemIds.length > 0 && this.purgeRemovedArtwork) {
				await this.purgeRemovedArtwork(libraryId, completed.removedItemIds).catch(() => undefined);
			}
			this.repository.invalidateSchedulingCatalog();
			this.publishScan(
				completed,
				completed.changedCount > 0
				|| completed.removedCount > 0
				|| (sourceWasUnavailable && discovery.traversalComplete),
			);
			return completed;
		}
		catch (error) {
			if (signal.aborted) {
				const cancelled = await this.repository.cancelScan(run);
				this.publishScan(cancelled, false);
				return cancelled;
			}

			const failed = await this.repository.failScan(run, error);
			this.repository.invalidateSchedulingCatalog();
			this.publishScan(failed, false);
			return failed;
		}
	}

	/** Stop library and release resources held by the library scan. */
	async stopLibrary(libraryId: string): Promise<void> {
		this.stoppedLibraries.add(libraryId);
		this.queuedTriggers.delete(libraryId);
		this.scanControllers.get(libraryId)?.abort();
		this.presenceControllers.get(libraryId)?.abort();
		const stopping = this.runLibraryOperation(libraryId, () => this.stopLibraryRuntime(libraryId));
		const active = this.activeScans.get(libraryId);
		const activePresence = this.activePresenceChecks.get(libraryId);
		await this.waitForWork(
			[stopping, ...(active ? [active] : []), ...(activePresence ? [activePresence] : [])],
			`library ${libraryId} shutdown`,
		);
		this.queuedTriggers.delete(libraryId);
	}

	/** Stop library runtime and release resources held by the library scan. */
	private async stopLibraryRuntime(libraryId: string): Promise<void> {
		const runtime = this.runtimes.get(libraryId);
		if (!runtime) {
			return;
		}

		this.runtimes.delete(libraryId);
		if (runtime.timer) {
			clearTimeout(runtime.timer);
		}
		if (runtime.debounce) {
			clearTimeout(runtime.debounce);
		}
		if (runtime.watcherRetry) {
			clearTimeout(runtime.watcherRetry);
		}
		this.presenceControllers.get(libraryId)?.abort();
		await this.activePresenceChecks.get(libraryId)?.catch(() => undefined);
		if (runtime.watcher) {
			await this.closeWatcher(libraryId, runtime, runtime.watcher);
		}
		if (!this.closing) {
			await this.setWatcherStatus(libraryId, 'stopped');
		}
	}

	/** Cancel pending work and stop every library watcher within the shutdown deadline. */
	async close(): Promise<void> {
		this.closing = true;
		this.started = false;
		this.closeDeadlineAt ??= Date.now() + this.cancellationGraceMs;
		this.queuedTriggers.clear();
		for (const controller of this.scanControllers.values()) {
			controller.abort();
		}
		for (const controller of this.presenceControllers.values()) {
			controller.abort();
		}
		const runtimeStops = [...this.runtimes.keys()].map((id) => this.stopLibraryRuntime(id));
		await this.waitForWork(
			[
				...runtimeStops,
				...this.libraryOperations.values(),
				...this.activeScans.values(),
				...this.activePresenceChecks.values(),
			],
			'scanner shutdown',
		);
	}

	/** Cancel the active scan and discard any coalesced follow-up request. */
	async cancelScan(libraryId: string): Promise<boolean> {
		const active = this.activeScans.get(libraryId);
		const controller = this.scanControllers.get(libraryId);
		this.queuedTriggers.delete(libraryId);
		if (!active || !controller) {
			return false;
		}

		controller.abort();
		await this.waitForWork([active], `library ${libraryId} scan cancellation`);
		return true;
	}

	/** Wait once for related work so many libraries cannot multiply the shutdown deadline. */
	private async waitForWork(work: Promise<unknown>[], label: string): Promise<void> {
		if (work.length === 0) {
			return;
		}

		let timer: NodeJS.Timeout | undefined;
		let timedOut = false;
		const remainingMs = this.closeDeadlineAt === null
			? this.cancellationGraceMs
			: Math.max(0, this.closeDeadlineAt - Date.now());
		await Promise.race<void>([
			Promise.allSettled(work).then(() => undefined),
			new Promise((resolve) => {
				timer = setTimeout(() => {
					timedOut = true;
					resolve();
				}, remainingMs);
				timer.unref();
			}),
		]);
		if (timer) {
			clearTimeout(timer);
		}
		if (timedOut) {
			this.logger?.warn(
				{ graceMs: this.cancellationGraceMs, operation: label },
				'Scanner operation exceeded its shutdown grace period',
			);
		}
	}

	/** Request watcher shutdown without allowing a native close to block the manager. */
	private async closeWatcher(
		libraryId: string,
		runtime: LibraryRuntime,
		watcher: SourceWatcher,
	): Promise<void> {
		if (runtime.watcher === watcher) {
			delete runtime.watcher;
		}
		await this.waitForWork(
			[Promise.resolve().then(() => watcher.close())],
			`library ${libraryId} watcher closure`,
		);
	}

	/** Release every live watcher while preserving periodic scanning. */
	async suspendWatchers(): Promise<void> {
		await Promise.allSettled([...this.runtimes.entries()].map(async ([libraryId, runtime]) => {
			if (!runtime.watcherDesired) {
				return;
			}

			if (runtime.watcher) {
				await this.closeWatcher(libraryId, runtime, runtime.watcher);
			}
			if (!this.closing) {
				await this.setWatcherStatus(libraryId, 'fallback');
				this.scheduleWatcherRetry(libraryId, runtime);
			}
		}));
	}

	/** Retry fallback watchers one at a time after resource pressure cools. */
	async recoverWatchers(): Promise<void> {
		for (const [libraryId, runtime] of this.runtimes) {
			if (runtime.watcher || !runtime.watcherDesired || this.closing) {
				continue;
			}

			const library = await this.repository.getLibraryScanTarget(libraryId);
			if (library?.enabled && library.watcherEnabled) {
				const adapter = this.sources.require(library.sourceType);
				if (adapter.createWatcher) {
					await this.startSourceWatcher(library, runtime, adapter);
				}
			}
		}
	}

	/** Start the platform watcher and fall back safely when it cannot be retained. */
	private async startSourceWatcher(
		library: Library,
		runtime: LibraryRuntime,
		adapter: LibrarySourceAdapter,
	): Promise<void> {
		if (runtime.watcherRetry) {
			clearTimeout(runtime.watcherRetry);
			delete runtime.watcherRetry;
		}
		await this.setWatcherStatus(library.id, 'starting');
		try {
			if (!adapter.createWatcher) {
				await this.setWatcherStatus(library.id, 'stopped');
				return;
			}

			const watcher = await adapter.createWatcher(library, {
				onChange: () => this.queueWatchedChange(library.id, runtime),
				onError: (error) => {
					void this.handleWatcherFailure(library.id, runtime, watcher, error);
				},
			});
			runtime.watcher = watcher;
			if (this.closing || this.stoppedLibraries.has(library.id)) {
				await this.closeWatcher(library.id, runtime, watcher);
				return;
			}

			runtime.watcherRetryAttempts = 0;
			await this.setWatcherStatus(library.id, 'ready');
		}
		catch (error) {
			const pressured = await this.resourcePressure?.report(error, 'source watcher startup') ?? false;
			if (!this.closing && !this.stoppedLibraries.has(library.id)) {
				await this.setWatcherStatus(library.id, pressured ? 'fallback' : 'error');
				this.scheduleWatcherRetry(library.id, runtime);
			}
		}
	}

	/** Debounce filesystem events before requesting a new scan. */
	private queueWatchedChange(libraryId: string, runtime: LibraryRuntime): void {
		if (runtime.debounce) {
			clearTimeout(runtime.debounce);
		}
		runtime.debounce = setTimeout(() => {
			void this.handleWatchedChange(libraryId).catch(() => undefined);
		}, 2_000);
	}

	/** Release a failed watcher and retain periodic scans during its backoff. */
	private async handleWatcherFailure(
		libraryId: string,
		runtime: LibraryRuntime,
		watcher: SourceWatcher,
		error: unknown,
	): Promise<void> {
		await this.resourcePressure?.report(error, 'source watcher').catch(() => undefined);
		if (runtime.watcher === watcher) {
			await this.closeWatcher(libraryId, runtime, watcher);
		}
		if (!this.closing && !this.stoppedLibraries.has(libraryId)) {
			await this.setWatcherStatus(libraryId, 'fallback');
			this.scheduleWatcherRetry(libraryId, runtime);
		}
	}

	/** Retry one fallback watcher with exponential backoff capped at one hour. */
	private scheduleWatcherRetry(libraryId: string, runtime: LibraryRuntime): void {
		if (runtime.watcherRetry || this.closing) {
			return;
		}

		const attempts = (runtime.watcherRetryAttempts ?? 0) + 1;
		runtime.watcherRetryAttempts = attempts;
		const delayMs = Math.min(60 * 60_000, 60_000 * (2 ** Math.min(5, attempts - 1)));
		runtime.watcherRetry = setTimeout(() => {
			delete runtime.watcherRetry;
			void this.runLibraryOperation(libraryId, async () => {
				const library = await this.repository.getLibraryScanTarget(libraryId);
				if (library?.enabled && library.watcherEnabled && !runtime.watcher) {
					const adapter = this.sources.require(library.sourceType);
					if (adapter.createWatcher) {
						await this.startSourceWatcher(library, runtime, adapter);
					}
				}
			}).catch(() => undefined);
		}, delayMs);
		runtime.watcherRetry.unref();
	}

	/** Serialize watcher changes for one library runtime. */
	private async runLibraryOperation(
		libraryId: string,
		operation: () => Promise<void>,
	): Promise<void> {
		const previous = this.libraryOperations.get(libraryId) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(operation);
		this.libraryOperations.set(libraryId, current);
		try {
			await current;
		}
		finally {
			if (this.libraryOperations.get(libraryId) === current) {
				this.libraryOperations.delete(libraryId);
			}
		}
	}

	/** Persist and broadcast the current watcher lifecycle state. */
	private async setWatcherStatus(
		libraryId: string,
		watcherStatus: Library['watcherStatus'],
	): Promise<void> {
		await this.repository.setWatcherStatus(libraryId, watcherStatus);
		this.events.publish({
			type: 'library.changed',
			data: { libraryId, change: 'watcher-status', watcherStatus },
		});
		await this.scheduleNextWork(libraryId);
	}

	/** Record a watched source change, notify clients, and request a coalesced scan. */
	private async handleWatchedChange(libraryId: string): Promise<void> {
		await this.repository.markChangeDetected(libraryId);
		this.events.publish({
			type: 'library.changed',
			data: { libraryId, change: 'change-detected' },
		});
		await this.scan(libraryId, 'watcher');
	}

	/** Start an internally queued scan and contain asynchronous failures. */
	private launchScan(libraryId: string, trigger: ScanRun['trigger']): void {
		void this.scan(libraryId, trigger).catch(() => undefined);
	}

	/** Publish a bounded running-scan update when its phase changes or throttle interval elapses. */
	private publishScanProgress(scan: ScanRun, progress: ScanProgress): void {
		const previous = this.lastProgress.get(scan.libraryId);
		const timestamp = Date.now();
		const lastPublishedAt = this.lastProgressPublishedAt.get(scan.libraryId) ?? 0;
		const phaseChanged = previous?.phase !== progress.phase;
		const reachedEnd
			= progress.totalCount !== null && progress.processedCount >= progress.totalCount;
		this.lastProgress.set(scan.libraryId, progress);
		if (
			!phaseChanged
			&& !reachedEnd
			&& timestamp - lastPublishedAt < ScannerManager.progressIntervalMs
		) {
			return;
		}

		this.lastProgressPublishedAt.set(scan.libraryId, timestamp);
		this.publishScan(scan, false, progress);
	}

	/** Publish scan state and optional transient progress through the live event stream. */
	private publishScan(
		scan: ScanRun,
		affectsProgramming: boolean,
		progress?: ScanProgress,
	): void {
		this.events.publish({
			type: 'scan.changed',
			data: {
				libraryId: scan.libraryId,
				scanId: scan.id,
				trigger: scan.trigger,
				status: scan.status,
				startedAt: scan.startedAt,
				completedAt: scan.completedAt,
				discoveredCount: scan.discoveredCount,
				changedCount: scan.changedCount,
				removedCount: scan.removedCount,
				issueCount: scan.issues.filter(issue => !isSuppressedScanIssue(issue)).length,
				affectsProgramming,
				...(progress ? { progress } : {}),
			},
		});
	}
}
