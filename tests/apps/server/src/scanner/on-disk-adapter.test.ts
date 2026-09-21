import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Library } from '@moirai/shared';
import type { MediaProbe } from '@server/media/media-probe.js';
import { OnDiskSourceAdapter } from '@server/scanner/on-disk-adapter.js';

const mocks = vi.hoisted(() => ({
	checkPresence: vi.fn(),
	discover: vi.fn(),
	createWatcher: vi.fn(),
}));
vi.mock('@server/scanner/on-disk.js', () => ({
	checkOnDiskPresence: mocks.checkPresence,
	discoverOnDisk: mocks.discover,
}));
vi.mock('@server/scanner/source-watcher.js', () => ({ createSourceWatcher: mocks.createWatcher }));

const roots: string[] = [];

afterEach(async () => {
	mocks.discover.mockReset();
	mocks.checkPresence.mockReset();
	mocks.createWatcher.mockReset();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function library(scanRoot: string): Library {
	return {
		id: crypto.randomUUID(),
		name: 'Movies',
		typeKey: 'movies',
		sourceType: 'on-disk',
		sourceConfig: { scanRoot, playbackRoot: null },
		scanIntervalMinutes: 15,
		watcherEnabled: true,
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
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

describe('OnDiskSourceAdapter', () => {
	it('validates directory configuration before accepting it', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-adapter-'));
		roots.push(root);
		const adapter = new OnDiskSourceAdapter();

		await expect(adapter.validateConfig({ scanRoot: root, playbackRoot: null })).resolves.toBeUndefined();
		await expect(adapter.validateConfig({ scanRoot: path.join(root, 'missing'), playbackRoot: null }))
			.rejects.toThrow();
	});

	it('classifies scan roots as identity and playback roots as index changes', () => {
		const adapter = new OnDiskSourceAdapter();
		const existing = { scanRoot: '/scan', playbackRoot: '/media' };

		expect(adapter.configurationImpact(existing, existing)).toBe('none');
		expect(adapter.configurationImpact(existing, { ...existing, playbackRoot: '/replacement' }))
			.toBe('index');
		expect(adapter.configurationImpact(existing, { ...existing, scanRoot: '/replacement' }))
			.toBe('identity');
	});

	it('supplies cached probes, progress, concurrency, and technical probing to discovery', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-adapter-'));
		roots.push(root);
		const probe = {
			concurrencyLimit: 3,
			probe: vi.fn(),
			inspectTail: vi.fn(),
		} as unknown as MediaProbe;
		const adapter = new OnDiskSourceAdapter(probe);
		const discovery = {
			groups: [],
			items: [],
			issues: [],
			traversalComplete: true,
			sourceIdentity: { sourceType: 'on-disk', sourceKey: root, details: {} },
			conflicts: [],
		};
		mocks.discover.mockResolvedValue(discovery);
		const probeCache = new Map();
		const onProgress = vi.fn();
		const signal = new AbortController().signal;

		await expect(adapter.discover(library(root), { signal, probeCache, onProgress }))
			.resolves.toBe(discovery);
		expect(mocks.discover).toHaveBeenCalledWith(
			expect.objectContaining({ sourceType: 'on-disk' }),
			expect.objectContaining({
				signal,
				probeCache,
				onProgress,
				discoveryConcurrency: 3,
				probeMedia: expect.any(Function),
			}),
		);
	});

	it('delegates targeted paths without invoking discovery or the media probe', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-adapter-'));
		roots.push(root);
		const probe = { concurrencyLimit: 3, probe: vi.fn() } as unknown as MediaProbe;
		const adapter = new OnDiskSourceAdapter(probe);
		const targets = [{ itemId: 'missing', stableKey: 'movie', relativePaths: ['Movie.mkv'] }];
		const checked = {
			sourceIdentity: { sourceType: 'on-disk', sourceKey: root, details: {} },
			observations: [{ itemId: 'missing', status: 'absent' as const }],
		};
		mocks.checkPresence.mockResolvedValue(checked);
		const signal = new AbortController().signal;

		await expect(adapter.checkPresence(library(root), targets, { signal })).resolves.toBe(checked);
		expect(mocks.checkPresence).toHaveBeenCalledWith(root, targets, signal);
		expect(mocks.discover).not.toHaveBeenCalled();
		expect(probe.probe).not.toHaveBeenCalled();
	});

	it('delegates optional live monitoring to the filesystem watcher', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-adapter-'));
		roots.push(root);
		const watcher = { close: vi.fn() };
		mocks.createWatcher.mockResolvedValue(watcher);
		const callbacks = { onChange: vi.fn(), onError: vi.fn() };
		const adapter = new OnDiskSourceAdapter();

		await expect(adapter.createWatcher(library(root), callbacks)).resolves.toBe(watcher);
		expect(mocks.createWatcher).toHaveBeenCalledWith(root, callbacks);
	});
});
