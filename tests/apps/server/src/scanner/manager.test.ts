import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Library, ScanRun } from '@moirai/shared';
import type { Repository } from '@server/repository/index.js';
import type { LibrarySourceAdapter } from '@server/scanner/contracts.js';
import { ScannerManager } from '@server/scanner/manager.js';
import { LibrarySourceRegistry } from '@server/scanner/source-registry.js';

const mocks = vi.hoisted(() => ({ discoverOnDisk: vi.fn(), createSourceWatcher: vi.fn() }));

function sourceRegistry(watchable = true): LibrarySourceRegistry {
	const adapter: LibrarySourceAdapter = {
		sourceType: 'on-disk',
		validateConfig: vi.fn().mockResolvedValue(undefined),
		configurationImpact: vi.fn().mockReturnValue('none'),
		discover: (target, context) => mocks.discoverOnDisk(target, context),
		...(watchable
			? {
				createWatcher: (
					target: Library,
					callbacks: Parameters<NonNullable<LibrarySourceAdapter['createWatcher']>>[1],
				) => mocks.createSourceWatcher(target, callbacks),
			}
			: {}),
	};
	return new LibrarySourceRegistry([adapter]);
}

const library: Library = {
	id: '0da47119-382e-4bf1-9cdf-009ce933bf64',
	name: 'Movies',
	typeKey: 'movies',
	sourceType: 'on-disk',
	sourceConfig: { scanRoot: '/media', playbackRoot: null },
	scanIntervalMinutes: 15,
	watcherEnabled: false,
	enabled: true,
	watcherStatus: 'stopped',
	sourceAvailability: 'available',
	sourceAvailabilityUpdatedAt: null,
	reconciliationStatus: 'idle',
	pendingRemovalCount: 0,
	lastScanStartedAt: null,
	lastScanCompletedAt: null,
	lastChangeDetectedAt: null,
	lastIndexedChangeAt: null,
	itemCount: 0,
	warningCount: 0,
	createdAt: '',
	updatedAt: '',
};

const running: ScanRun = {
	id: '2be7a2b9-81b5-4a72-a3d8-ad4e6394dd25',
	libraryId: library.id,
	trigger: 'manual',
	status: 'running',
	startedAt: '',
	completedAt: null,
	discoveredCount: 0,
	changedCount: 0,
	removedCount: 0,
	issues: [],
};

describe('ScannerManager', () => {
	beforeEach(() => {
		mocks.discoverOnDisk.mockReset();
		mocks.createSourceWatcher.mockReset();
	});

	it('falls back to periodic scans when watcher startup exhausts resources', async () => {
		const watchedLibrary = {
			...library,
			watcherEnabled: true,
			sourceConfig: { ...library.sourceConfig, scanRoot: process.cwd() },
		};
		const repository = {
			getLibraryScanTarget: vi.fn().mockResolvedValue(watchedLibrary),
			setWatcherStatus: vi.fn().mockResolvedValue(undefined),
		} as unknown as Repository;
		mocks.createSourceWatcher.mockRejectedValue(
			Object.assign(new Error('capacity'), { code: 'EMFILE' }),
		);
		const pressure = { report: vi.fn().mockResolvedValue(true) };
		const manager = new ScannerManager(
			repository,
			{ publish: vi.fn() },
			sourceRegistry(),
			5_000,
			undefined,
			undefined,
			pressure as never,
		);

		await manager.refreshLibrary(library.id);

		expect(pressure.report).toHaveBeenCalled();
		expect(repository.setWatcherStatus).toHaveBeenLastCalledWith(library.id, 'fallback');
		await manager.close();
	});

	it('uses periodic scanning without starting a watcher when the adapter does not support one', async () => {
		const unwatchedLibrary = { ...library, watcherEnabled: true };
		const repository = {
			getLibraryScanTarget: vi.fn().mockResolvedValue(unwatchedLibrary),
			setWatcherStatus: vi.fn().mockResolvedValue(undefined),
		} as unknown as Repository;
		const manager = new ScannerManager(
			repository,
			{ publish: vi.fn() },
			sourceRegistry(false),
		);

		await manager.refreshLibrary(library.id);

		expect(mocks.createSourceWatcher).not.toHaveBeenCalled();
		expect(repository.setWatcherStatus).toHaveBeenLastCalledWith(library.id, 'stopped');
		await manager.close();
	});

	it('publishes scan discovery, processing, and finalization progress', async () => {
		const completed = {
			...running,
			status: 'complete' as const,
			completedAt: new Date().toISOString(),
			removedItemIds: [],
		};
		const repository = {
			getLibraryScanTarget: vi.fn().mockResolvedValue(library),
			beginScan: vi.fn().mockResolvedValue(running),
			listMediaProbeCache: vi.fn().mockResolvedValue([]),
			reconcileScan: vi.fn().mockResolvedValue(completed),
			invalidateSchedulingCatalog: vi.fn(),
		} as unknown as Repository;
		let finishDiscovery!: (value: {
			groups: [];
			items: [];
			issues: [];
			traversalComplete: true;
			sourceIdentity: {
				sourceType: string;
				sourceKey: string;
				details: Record<string, string>;
			};
			conflicts: [];
		}) => void;
		mocks.discoverOnDisk.mockReturnValue(new Promise((resolve) => {
			finishDiscovery = resolve;
		}));
		const publish = vi.fn();
		const manager = new ScannerManager(repository, { publish }, sourceRegistry());

		const scanning = manager.scan(library.id, 'manual');
		await vi.waitFor(() => expect(mocks.discoverOnDisk).toHaveBeenCalledOnce());
		const options = mocks.discoverOnDisk.mock.calls[0]?.[1];
		expect(options).toBeDefined();
		options.onProgress?.({
			phase: 'processing',
			processedCount: 0,
			totalCount: 2,
		});
		options.onProgress?.({
			phase: 'processing',
			processedCount: 1,
			totalCount: 2,
		});
		options.onProgress?.({
			phase: 'finalizing',
			processedCount: 2,
			totalCount: 2,
		});
		finishDiscovery({
			groups: [],
			items: [],
			issues: [],
			traversalComplete: true,
			sourceIdentity: {
				sourceType: 'on-disk',
				sourceKey: '/media',
				details: { canonicalRoot: '/media', device: '1', inode: '1' },
			},
			conflicts: [],
		});

		await scanning;

		const progress = publish.mock.calls
			.map(([event]) => event.data.progress)
			.filter(Boolean);
		expect(progress).toEqual([
			{ phase: 'discovering', processedCount: 0, totalCount: null },
			{ phase: 'processing', processedCount: 0, totalCount: 2 },
			{ phase: 'finalizing', processedCount: 2, totalCount: 2 },
		]);
	});

	it('marks a healthy source recovery as affecting dependent programming', async () => {
		const recoveringLibrary = {
			...library,
			sourceAvailability: 'unavailable' as const,
		};
		const completed = {
			...running,
			status: 'complete' as const,
			completedAt: new Date().toISOString(),
			removedItemIds: [],
		};
		const repository = {
			getLibraryScanTarget: vi.fn().mockResolvedValue(recoveringLibrary),
			beginScan: vi.fn().mockResolvedValue(running),
			listMediaProbeCache: vi.fn().mockResolvedValue([]),
			reconcileScan: vi.fn().mockResolvedValue(completed),
			invalidateSchedulingCatalog: vi.fn(),
		} as unknown as Repository;
		mocks.discoverOnDisk.mockResolvedValue({
			groups: [],
			items: [],
			issues: [],
			traversalComplete: true,
			sourceIdentity: {
				sourceType: 'on-disk',
				sourceKey: '/media',
				details: { canonicalRoot: '/media', device: '1', inode: '1' },
			},
			conflicts: [],
		});
		const publish = vi.fn();
		const manager = new ScannerManager(repository, { publish }, sourceRegistry());

		await manager.scan(library.id, 'manual');

		expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
			type: 'scan.changed',
			data: expect.objectContaining({
				status: 'complete',
				affectsProgramming: true,
			}),
		}));
	});

	it('cancels queued work and drains the active scan before library removal', async () => {
		let finishDiscovery!: (value: {
			groups: [];
			items: [];
			issues: [];
			traversalComplete: true;
			sourceIdentity: {
				sourceType: string;
				sourceKey: string;
				details: Record<string, string>;
			};
		}) => void;
		mocks.discoverOnDisk.mockReturnValue(
			new Promise((resolve) => {
				finishDiscovery = resolve;
			}),
		);
		const completed = {
			...running,
			status: 'complete' as const,
			completedAt: '',
			removedItemIds: [],
		};
		const cancelled = { ...running, status: 'cancelled' as const, completedAt: '' };
		const repository = {
			getLibraryScanTarget: vi.fn().mockResolvedValue(library),
			beginScan: vi.fn().mockResolvedValue(running),
			reconcileScan: vi.fn().mockResolvedValue(completed),
			cancelScan: vi.fn().mockResolvedValue(cancelled),
			failScan: vi.fn(),
			invalidateSchedulingCatalog: vi.fn(),
		} as unknown as Repository;
		const manager = new ScannerManager(
			repository,
			{ publish: vi.fn() },
			sourceRegistry(),
		);

		const active = manager.scan(library.id, 'manual');
		await vi.waitFor(() => expect(mocks.discoverOnDisk).toHaveBeenCalledOnce());
		const queued = manager.scan(library.id, 'periodic');
		const stopping = manager.stopLibrary(library.id);
		finishDiscovery({
			groups: [],
			items: [],
			issues: [],
			traversalComplete: true,
			sourceIdentity: {
				sourceType: 'on-disk',
				sourceKey: '/media',
				details: { canonicalRoot: '/media', device: '1', inode: '1' },
			},
		});

		await Promise.all([active, queued, stopping]);
		await Promise.resolve();
		expect(repository.beginScan).toHaveBeenCalledOnce();
		await expect(manager.scan(library.id, 'manual')).rejects.toThrow('scanning has stopped');
	});

	it('bounds watcher closure and queued library operations during shutdown', async () => {
		const repository = {} as Repository;
		const logger = { warn: vi.fn() };
		const manager = new ScannerManager(
			repository,
			{ publish: vi.fn() },
			sourceRegistry(),
			10,
			undefined,
			logger as never,
		);
		const never = new Promise<void>(() => undefined);
		const internals = manager as unknown as {
			runtimes: Map<string, { watcher: { close: () => Promise<void> } }>;
			libraryOperations: Map<string, Promise<void>>;
		};
		internals.runtimes.set(library.id, { watcher: { close: vi.fn(() => never) } });
		internals.libraryOperations.set(library.id, never);

		await manager.close();

		expect(internals.runtimes.size).toBe(0);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ graceMs: 10, operation: 'scanner shutdown' }),
			expect.any(String),
		);
	});
});
