import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { LiveEventPublisher } from '@server/operations/live-events.js';
import type { HardwareAccelerationResolver } from '@server/playback/hardware-acceleration.js';
import { PlaybackEngine } from '@server/playback/playback-engine.js';
import type { PlayoutSynchronizer } from '@server/playback/playout-synchronizer.js';
import type { Repository } from '@server/repository/index.js';

describe('playback engine fallback changes', () => {
	it('moves active and inactive channels before a global override is removed', async () => {
		const active = randomUUID();
		const inactive = randomUUID();
		const repository = {
			listChannels: vi.fn(async () => [{ id: active }, { id: inactive }]),
		} as unknown as Repository;
		const playout = {
			syncChannel: vi.fn(async () => '/playout/channel'),
		} as unknown as PlayoutSynchronizer;
		const engine = new PlaybackEngine(
			repository,
			playout,
			{ publish: vi.fn() } as LiveEventPublisher,
			{ warn: vi.fn() } as unknown as FastifyBaseLogger,
			{} as HardwareAccelerationResolver,
			'/engine',
			'/streams',
			'http://localhost',
			1_000,
			1_000,
		);
		const internals = engine as unknown as {
			sessions: Map<string, unknown>;
			stop(channelId: string): Promise<void>;
		};
		internals.sessions.set(active, {});
		vi.spyOn(internals, 'stop').mockImplementation(async (channelId) => {
			internals.sessions.delete(channelId);
		});
		const restart = vi.spyOn(engine, 'restart').mockResolvedValue(undefined);

		await engine.transitionFallbackRemoval(null);

		expect(restart).toHaveBeenCalledWith(active);
		expect(playout.syncChannel).toHaveBeenCalledWith(inactive);
		expect(playout.syncChannel).not.toHaveBeenCalledWith(active);
	});

	it('stops active workers before replacing a fallback and leaves inactive channels stopped', async () => {
		const active = randomUUID();
		const inactive = randomUUID();
		let activated = false;
		const repository = {
			listChannels: vi.fn(async () => [{ id: active }, { id: inactive }]),
		} as unknown as Repository;
		const playout = {
			syncChannel: vi.fn(async () => {
				expect(activated).toBe(true);
				return '/playout/channel';
			}),
		} as unknown as PlayoutSynchronizer;
		const engine = new PlaybackEngine(
			repository,
			playout,
			{ publish: vi.fn() } as LiveEventPublisher,
			{ warn: vi.fn() } as unknown as FastifyBaseLogger,
			{} as HardwareAccelerationResolver,
			'/engine',
			'/streams',
			'http://localhost',
			1_000,
			1_000,
		);
		const internals = engine as unknown as {
			sessions: Map<string, unknown>;
			stop(channelId: string): Promise<void>;
		};
		internals.sessions.set(active, {});
		const stop = vi.spyOn(internals, 'stop').mockImplementation(async (channelId) => {
			internals.sessions.delete(channelId);
		});
		const restart = vi.spyOn(engine, 'restart').mockImplementation(async () => {
			expect(activated).toBe(true);
		});
		const activate = vi.fn(async () => {
			expect(stop).toHaveBeenCalledWith(active);
			activated = true;
		});

		await engine.transitionFallbackReplacement(null, activate);

		expect(restart).toHaveBeenCalledWith(active);
		expect(playout.syncChannel).toHaveBeenCalledWith(inactive);
	});
});
