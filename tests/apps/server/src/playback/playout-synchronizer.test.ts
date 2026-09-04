import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { FallbackFillerStore } from '@server/playback/fallback-filler-store.js';
import { PlayoutSynchronizer } from '@server/playback/playout-synchronizer.js';
import type { LiveEventPublisher } from '@server/operations/live-events.js';
import type { Repository } from '@server/repository/index.js';

describe('playout synchronizer', () => {
	it('removes orphaned playout before reconciling deleted-channel fallback state', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-playout-reconcile-'));
		const channelId = randomUUID();
		const channelFolder = path.join(root, channelId);
		await mkdir(channelFolder, { recursive: true });
		const reconcileChannels = vi.fn(async () => {
			await expect(access(channelFolder)).rejects.toMatchObject({ code: 'ENOENT' });
		});
		const repository = {
			listChannels: vi.fn(async () => []),
		} as unknown as Repository;
		const fallbackFillers = {
			reconcileChannels,
		} as unknown as FallbackFillerStore;
		const synchronizer = new PlayoutSynchronizer(
			repository,
			root,
			'UTC',
			60,
			vi.fn(async () => undefined),
			fallbackFillers,
			{ publish: vi.fn() } as LiveEventPublisher,
			{ error: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger,
		);

		try {
			await synchronizer.syncAll();
			expect(reconcileChannels).toHaveBeenCalledWith(new Set());
		}
		finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('runs a queued invalidation after an active synchronization fails', async () => {
		let releaseFailure: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const failureGate = new Promise<void>((resolve) => {
			releaseFailure = resolve;
		});
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const events = { publish: vi.fn() } as LiveEventPublisher;
		const synchronizer = new PlayoutSynchronizer(
			{} as Repository,
			'/playout',
			'UTC',
			60,
			vi.fn(async () => undefined),
			{} as FallbackFillerStore,
			events,
			{ error: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger,
		);
		const perform = vi.spyOn(
			synchronizer as unknown as {
				performChannelSync(channelId: string): Promise<string>;
			},
			'performChannelSync',
		)
			.mockImplementationOnce(async () => {
				markStarted?.();
				await failureGate;
				throw new Error('first pass failed');
			})
			.mockResolvedValueOnce('/playout/recovered');
		const channelId = randomUUID();

		const first = synchronizer.syncChannel(channelId);
		await started;
		const queued = synchronizer.syncChannel(channelId);
		releaseFailure?.();

		await expect(first).resolves.toBe('/playout/recovered');
		await expect(queued).resolves.toBe('/playout/recovered');
		expect(perform).toHaveBeenCalledTimes(2);
		expect(synchronizer.channelFailure(channelId)).toBeNull();
		expect(events.publish).toHaveBeenCalledOnce();
	});

	it('starts a new pass when invalidation arrives as the prior pass completes', async () => {
		let releaseFirst: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const synchronizer = new PlayoutSynchronizer(
			{} as Repository,
			'/playout',
			'UTC',
			60,
			vi.fn(async () => undefined),
			{} as FallbackFillerStore,
			{ publish: vi.fn() } as LiveEventPublisher,
			{ error: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger,
		);
		const perform = vi.spyOn(
			synchronizer as unknown as {
				performChannelSync(channelId: string): Promise<string>;
			},
			'performChannelSync',
		)
			.mockImplementationOnce(async () => {
				markStarted?.();
				await firstGate;
				return '/playout/first';
			})
			.mockResolvedValueOnce('/playout/second');
		const channelId = randomUUID();

		const first = synchronizer.syncChannel(channelId);
		await started;
		let queued: Promise<string> | null = null;
		const pending = (synchronizer as unknown as { pending: Set<string> }).pending;
		const pendingHas = pending.has.bind(pending);
		vi.spyOn(pending, 'has').mockImplementationOnce((value) => {
			const result = pendingHas(value);
			queueMicrotask(() => {
				queued = synchronizer.syncChannel(channelId);
			});
			return result;
		});
		releaseFirst?.();

		await expect(first).resolves.toBe('/playout/first');
		await expect(queued).resolves.toBe('/playout/second');
		expect(perform).toHaveBeenCalledTimes(2);
	});
});
