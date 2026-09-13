import { mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { channelCreateSchema, type Channel } from '@moirai/shared';
import type { FallbackFillerStore } from '@server/playback/fallback-filler-store.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { LiveEventPublisher } from '@server/operations/live-events.js';
import type { HardwareAccelerationResolver } from '@server/playback/hardware-acceleration.js';
import { PlaybackEngine } from '@server/playback/playback-engine.js';
import { PlayoutSynchronizer } from '@server/playback/playout-synchronizer.js';
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

it('stops incompatible subtitle workers before publication and resumes them after synchronization', async () => {
	const channel = { id: randomUUID(), subtitleMode: 'convert' as const };
	const playout = { subtitleMode: () => 'burn' } as unknown as PlayoutSynchronizer;
	const engine = new PlaybackEngine(
		{ getChannel: async () => channel } as unknown as Repository,
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
		running: boolean;
		stop(id: string): Promise<void>;
	};
	internals.running = true;
	internals.sessions.set(channel.id, { subtitleMode: 'convert' });
	const stop = vi.spyOn(internals, 'stop').mockImplementation(async (id) => {
		internals.sessions.delete(id);
	});
	const ensure = vi.spyOn(engine, 'ensureSession').mockResolvedValue();
	await playout.beforeSubtitleModeChange(channel.id, 'convert');
	expect(stop).not.toHaveBeenCalled();
	await playout.beforeSubtitleModeChange(channel.id, 'burn');
	expect(stop).toHaveBeenCalledOnce();
	expect(ensure).not.toHaveBeenCalled();
	await engine.handlePlayoutChange(channel.id);
	expect(ensure).toHaveBeenCalledWith(channel);
	await engine.handlePlayoutChange(channel.id);
	expect(ensure).toHaveBeenCalledOnce();
	await playout.beforeSubtitleModeChange('inactive', 'burn');
	await engine.handlePlayoutChange('inactive');
	expect(ensure).toHaveBeenCalledOnce();
});

it('retries a subtitle restart after a forcibly stopped worker exits late', async () => {
	vi.useFakeTimers();
	try {
		const channel = { id: randomUUID(), subtitleMode: 'convert' as const };
		const playout = { subtitleMode: () => 'burn' } as unknown as PlayoutSynchronizer;
		const engine = new PlaybackEngine(
			{ getChannel: async () => channel } as unknown as Repository,
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
		const child = new EventEmitter();
		const session = { channel, child, subtitleMode: 'convert', state: 'ready', rejectReady: vi.fn() };
		const internals = engine as unknown as {
			running: boolean;
			sessions: Map<string, unknown>;
			observeExit(session: unknown): void;
			signal(session: unknown, signal: string): void;
			startSession(channel: Channel): Promise<void>;
		};
		internals.running = true;
		internals.sessions.set(channel.id, session);
		internals.observeExit(session);
		const signal = vi.spyOn(internals, 'signal').mockImplementation(() => {});
		const start = vi.spyOn(internals, 'startSession').mockResolvedValue();

		const stop = playout.beforeSubtitleModeChange(channel.id, 'burn');
		await vi.advanceTimersByTimeAsync(1_000);
		await stop;
		expect(signal).toHaveBeenCalledWith(session, 'SIGKILL');
		await expect(engine.handlePlayoutChange(channel.id)).rejects.toThrow('Channel stream is restarting');
		expect(start).not.toHaveBeenCalled();

		child.emit('exit', null, 'SIGKILL');
		await engine.handlePlayoutChange(channel.id);
		expect(start).toHaveBeenCalledWith(channel, undefined);
		await engine.handlePlayoutChange(channel.id);
		expect(start).toHaveBeenCalledOnce();
	}
	finally {
		vi.useRealTimers();
	}
});

it.each(['configuration', 'spawn'] as const)('coordinates a subtitle mode change during worker %s', async (phase) => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-startup-mode-'));
	const channel = { ...channelCreateSchema.parse({ number: '1', name: 'Music', subtitleMode: 'convert', video: { accel: null } }), id: randomUUID(), createdAt: '', updatedAt: '' };
	let mode: Channel['subtitleMode'] = 'convert';
	const events = { publish: vi.fn() } as LiveEventPublisher;
	const logger = { error: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
	const playout = new PlayoutSynchronizer({} as Repository, root, 'UTC', 60, async () => {}, {} as FallbackFillerStore, events, logger);
	vi.spyOn(playout, 'subtitleMode').mockImplementation(() => mode);
	const engine = new PlaybackEngine({} as Repository, playout, events, logger, {} as HardwareAccelerationResolver, '/engine', root, 'http://localhost', 1000, 1000);
	let release!: () => void;
	let reached!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const paused = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const end = vi.fn();
	const internals = engine as unknown as {
		running: boolean;
		sessions: Map<string, { subtitleMode: string; resolveReady(): void }>;
		effectiveChannel(): Promise<unknown>;
		spawnEngine(): Promise<unknown>;
		launchSession(channel: Channel): Promise<void>;
		logChildOutput(): void;
		observeExit(): void;
		waitUntilReady(session: { resolveReady(): void }): Promise<void>;
		stop(id: string): Promise<void>;
	};
	internals.running = true;
	vi.spyOn(internals, 'effectiveChannel').mockImplementation(async () => {
		if (phase === 'configuration') {
			reached();
			await gate;
		}
		return { ...channel };
	});
	vi.spyOn(internals, 'spawnEngine').mockImplementation(async () => {
		if (phase === 'spawn') {
			reached();
			await gate;
		}
		return { stdin: { end } };
	});
	vi.spyOn(internals, 'logChildOutput').mockImplementation(() => {});
	vi.spyOn(internals, 'observeExit').mockImplementation(() => {});
	vi.spyOn(internals, 'waitUntilReady').mockImplementation(async (session) => session.resolveReady());
	const stop = vi.spyOn(internals, 'stop').mockImplementation(async (id) => {
		internals.sessions.delete(id);
	});
	let published = false;
	try {
		const launch = internals.launchSession(channel);
		await paused;
		const publish = playout.withChannelConfiguration(channel.id, async () => {
			await playout.beforeSubtitleModeChange(channel.id, 'burn');
			mode = 'burn';
			published = true;
		});
		if (phase === 'configuration') {
			await publish;
		}
		else {
			await new Promise((resolve) => setImmediate(resolve));
			expect(published).toBe(false);
		}
		release();
		await Promise.all([launch, publish]);
		const config = JSON.parse(end.mock.calls[0]![0]);
		expect(config.normalization.subtitle.mode).toBe(phase === 'configuration' ? 'burn' : 'convert');
		if (phase === 'spawn') {
			expect(stop).toHaveBeenCalledWith(channel.id);
			expect(internals.sessions.has(channel.id)).toBe(false);
		}
	}
	finally {
		release();
		await rm(root, { recursive: true, force: true });
	}
});

it.each([false, true])('keeps startup and unchanged-session fallback diagnostics consistent for debug=%s', async (debug) => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-debug-worker-'));
	const channel = { ...channelCreateSchema.parse({ number: '1', name: 'Debug', video: { accel: null } }), id: randomUUID(), createdAt: '', updatedAt: '' };
	const repository = { getChannel: async () => channel } as unknown as Repository;
	const events = { publish: vi.fn() } as LiveEventPublisher;
	const logger = { error: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
	const playout = new PlayoutSynchronizer(repository, root, 'UTC', 60, async () => {}, {} as FallbackFillerStore, events, logger);
	const engine = new PlaybackEngine(repository, playout, events, logger, {} as HardwareAccelerationResolver, '/engine', root, 'http://localhost', 1000, 1000, undefined, debug);
	const end = vi.fn();
	const internals = engine as unknown as {
		running: boolean;
		effectiveChannel(): Promise<unknown>;
		spawnEngine(): Promise<unknown>;
		launchSession(channel: Channel): Promise<void>;
		logChildOutput(): void;
		observeExit(): void;
		waitUntilReady(session: { resolveReady(): void }): Promise<void>;
	};
	internals.running = true;
	vi.spyOn(internals, 'effectiveChannel').mockImplementation(async () => ({ ...channel }));
	vi.spyOn(internals, 'spawnEngine').mockResolvedValue({ stdin: { end } });
	vi.spyOn(internals, 'logChildOutput').mockImplementation(() => {});
	vi.spyOn(internals, 'observeExit').mockImplementation(() => {});
	vi.spyOn(internals, 'waitUntilReady').mockImplementation(async (session) => session.resolveReady());
	try {
		await internals.launchSession(channel);
		expect(JSON.parse(end.mock.calls[0]![0])).toMatchObject({ fallback: { show_error: debug } });
		await engine.handleChannelChange(channel.id);
		expect(events.publish).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: 'stale' }) }));
		channel.video.width = 640;
		await engine.handleChannelChange(channel.id);
		expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: 'stale' }) }));
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});
