import { ETV_PLAYOUT_VERSION } from '@ersatztv-source/index.js';
import { LIVE_EVENT_PROTOCOL_VERSION, channelCreateSchema, playbackSettingsSchema, type ScheduleGuide, type LiveEventInput, type TimelineSegment } from '@moirai/shared';
import * as graphicsPlayout from '@server/graphics/playout.js';
import * as scheduleGuide from '@server/guide/schedule-guide.js';
import * as mediaStreams from '@server/playback/audio-selection.js';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, symlink, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { FallbackFillerStore } from '@server/playback/fallback-filler-store.js';
import { PlayoutSynchronizer } from '@server/playback/playout-synchronizer.js';
import type { LiveEventPublisher } from '@server/operations/live-events.js';
import type { Repository } from '@server/repository/index.js';
import { SchedulingWorkerPool } from '@server/scheduling/worker-pool.js';

/** Create independent log spies for each synchronizer, including publication timing. */
function loggerFixture(): FastifyBaseLogger {
	return { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
}

describe('playout synchronizer', () => {
	it.each([
		['another channel timeline', false], ['another channel edit', false], ['scan progress', false],
		['embedding progress', false], ['guide template', false], ['guide template with text graphics', true], ['watcher status', false],
		['this channel timeline', true], ['this channel edit', true], ['this channel edit during decoration', true], ['scan reconciliation', true],
		['global audio defaults', true], ['program preferences', true], ['credit template', true], ['library edit', true],
		['compatibility mid-roll edit', true], ['program metadata', false], ['program metadata with text graphics', true],
	] as const)('publishes live playout with the correct retry behavior during %s', async (change, retry) => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-playout-invalidation-'));
		const channel = { ...channelCreateSchema.parse({ number: '1', name: 'Live' }), id: randomUUID(),
			createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' };
		const channelsUsingScope = vi.fn(() => [channel.id]);
		const repository = { graphics: { assignments: () => new Map(), channelsUsingScope },
			getChannel: async () => channel, schedulingCatalogRevision: 0 } as unknown as Repository;
		const workers = new SchedulingWorkerPool(0, 32, { repository } as ConstructorParameters<typeof SchedulingWorkerPool>[2]);
		vi.spyOn(workers, 'databaseBacked', 'get').mockReturnValue(true);
		const otherId = randomUUID();
		let event: LiveEventInput;
		if (change.includes('channel')) {
			const channelId = change.startsWith('this') ? channel.id : otherId;
			event = change.endsWith('timeline') ? { type: 'timeline.changed', data: { channelId, status: 'ready' } }
				: { type: 'channel.changed', data: { channelId, change: 'updated' } };
		}
		else if (change === 'compatibility mid-roll edit') {
			event = { type: 'scheduling.changed', data: { entity: 'mid-roll-preset', change: 'updated', id: otherId } };
		}
		else if (change.startsWith('program metadata')) {
			event = { type: 'scheduling.changed', data: { entity: 'program', change: 'updated', id: otherId, affectsProgramming: false } };
		}
		else if (change === 'global audio defaults') {
			event = { type: 'playback.changed', data: { channelId: null, reason: 'settings-changed' } };
		}
		else if (change.startsWith('scan')) {
			event = { type: 'scan.changed', data: { libraryId: otherId, scanId: randomUUID(), trigger: 'manual',
				status: 'running', startedAt: channel.createdAt, completedAt: null, discoveredCount: 1,
				changedCount: 0, removedCount: 0, issueCount: 0, affectsProgramming: retry } };
		}
		else if (change === 'embedding progress') {
			event = { type: 'embeddings.changed', data: { pending: 1, failed: 0, status: 'working' } };
		}
		else if (change === 'library edit' || change === 'watcher status') {
			event = { type: 'library.changed', data: { libraryId: otherId, change: retry ? 'updated' : 'watcher-status' } };
		}
		else {
			event = { type: 'scheduling.changed', data: { id: otherId, change: 'updated',
				entity: change === 'program preferences' ? 'program' : change === 'credit template' ? 'credit-template' : 'guide-template' } };
		}
		const guide = { channels: [], timeZone: 'UTC', startDate: '2026-10-02', days: 3 } as unknown as ScheduleGuide;
		const filename = '20261002T000000.000000000+0000_20261003T000000.000000000+0000.json';
		let documentReads = 0;
		const duringDecoration = change === 'this channel edit during decoration';
		const destination = path.join(root, channel.id, filename);
		const decorate = duringDecoration ? vi.spyOn(graphicsPlayout, 'decorateGraphics').mockImplementation(async (...args) => {
			if (documentReads <= 3) {
				workers.invalidateReads(event);
			}
			return { files: args[4], used: new Map() };
		}) : undefined;
		const read = vi.spyOn(workers, 'playoutRead').mockImplementation(async request => {
			if (request.kind === 'playout-preparation') {
				if (duringDecoration) {
					await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
					return { channel, guide, programs: [], graphics: { presets: new Map(), segments: [] } };
				}
				return { channel, guide, programs: [], ...(change.endsWith('with text graphics')
					? { graphics: { presets: new Map(), segments: [], contexts: new Map() } } : {}) };
			}
			documentReads += 1;
			if (!duringDecoration && documentReads <= 3) {
				// Read caches still refresh globally, just as the app's event subscription requires.
				workers.invalidateReads(event);
			}
			return new Map([[filename, JSON.stringify({ pass: documentReads, items: [] })]]);
		});
		const synchronizer = new PlayoutSynchronizer(
			repository,
			root,
			'UTC',
			60,
			async () => {},
			{ resolve: async () => ({}) } as unknown as FallbackFillerStore,
			{ publish: vi.fn() },
			loggerFixture(),
			workers,
		);
		try {
			await synchronizer.syncChannel(channel.id, true);
			const passes = retry ? 4 : 1;
			expect(documentReads).toBe(passes);
			expect(read).toHaveBeenCalledTimes(passes * 2);
			expect(await readFile(destination, 'utf8')).toBe(JSON.stringify({ pass: passes, items: [] }));
			if (change === 'compatibility mid-roll edit' || change === 'program metadata with text graphics') {
				const sync = vi.spyOn(synchronizer, 'syncChannel').mockResolvedValue(path.dirname(destination));
				synchronizer.handleEvent({ ...event, protocolVersion: LIVE_EVENT_PROTOCOL_VERSION,
					eventId: randomUUID(), occurredAt: channel.updatedAt });
				expect(channelsUsingScope).toHaveBeenCalledExactlyOnceWith(change.startsWith('program') ? 'program' : 'filler', otherId);
				expect(sync).toHaveBeenCalledExactlyOnceWith(channel.id);
			}
		}
		finally {
			decorate?.mockRestore();
			await synchronizer.close();
			await workers.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it('promotes a shared periodic pass for a live tune and carries priority through publication', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-live-playout-'));
		const channel = channelCreateSchema.parse({ number: '1', name: 'Live' });
		const saved = { ...channel, id: randomUUID(), createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' };
		const guide = { channels: [], timeZone: 'UTC', startDate: '2026-10-02', days: 3 } as unknown as ScheduleGuide;
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const preparation = { channel: saved, guide, programs: [] };
		const workers = {
			databaseBacked: true, playoutRevision: () => 'unchanged', promotePlayout: vi.fn(),
			playoutRead: vi.fn().mockImplementationOnce(async () => {
				await gate;
				return preparation;
			}).mockResolvedValueOnce(new Map()).mockResolvedValueOnce(preparation).mockResolvedValueOnce(new Map()),
		};
		const synchronizer = new PlayoutSynchronizer(
			{ graphics: { assignments: () => new Map() }, getChannel: vi.fn(async () => saved) } as unknown as Repository,
			root,
			'UTC',
			60,
			vi.fn(async () => {}),
			{ resolve: vi.fn(async () => ({})) } as unknown as FallbackFillerStore,
			{ publish: vi.fn() } as LiveEventPublisher,
			loggerFixture(),
			workers as unknown as SchedulingWorkerPool,
		);
		const periodic = synchronizer.syncChannel(saved.id);
		try {
			await vi.waitFor(() => expect(workers.playoutRead).toHaveBeenCalledTimes(1));
			const live = synchronizer.syncChannel(saved.id, true);
			expect(live).toBe(periodic);
			expect(workers.promotePlayout).toHaveBeenCalledWith(saved.id);
			release();
			await live;
			expect(workers.playoutRead).toHaveBeenCalledTimes(2);
			expect(workers.playoutRead.mock.calls[0]?.[1]).toBe(false);
			expect(workers.playoutRead.mock.calls[1]?.[1]).toBe(true);
			await synchronizer.syncChannel(saved.id);
			expect(workers.playoutRead.mock.calls.slice(2).map(call => call[1])).toEqual([false, false]);
		}
		finally {
			release();
			await periodic.catch(() => {});
			await synchronizer.close();
			await rm(root, { recursive: true, force: true });
		}
	});

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
			loggerFixture(),
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
			loggerFixture(),
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
			loggerFixture(),
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

	it('does not materialize when committed playout coverage is already available', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-playout-ready-'));
		const channelId = randomUUID();
		const channel = {
			...channelCreateSchema.parse({ number: '1', name: 'Ready' }),
			id: channelId,
			createdAt: '',
			updatedAt: '',
		};
		const ensureMaterialized = vi.fn(async () => undefined);
		const synchronizer = new PlayoutSynchronizer(
			{
				graphics: { assignments: () => new Map() }, getChannel: async () => channel,
				getPlaybackSettings: async () => playbackSettingsSchema.parse({ audioPreferences: { language: 'fr' } }),
				listPrograms: async () => [],
			} as unknown as Repository,
			root,
			'UTC',
			60,
			ensureMaterialized,
			{ resolve: async () => ({}) } as unknown as FallbackFillerStore,
			{ publish: vi.fn() } as LiveEventPublisher,
			loggerFixture(),
		);
		const guide = vi.spyOn(scheduleGuide, 'readCommittedChannelScheduleGuide').mockResolvedValue({
			timeZone: 'UTC',
			startDate: '2026-08-23',
			requestedDays: 1,
			days: 1,
			segmentLimitApplied: false,
			channels: [],
		} as ScheduleGuide);
		vi.spyOn(synchronizer.subtitles, 'prepare').mockResolvedValue(new Map());
		vi.spyOn(
			synchronizer as unknown as { channelFiles(): { files: Map<string, string>; usedGraphics: Map<string, number> } },
			'channelFiles',
		).mockReturnValue({ files: new Map(), usedGraphics: new Map() });
		try {
			await synchronizer.syncChannel(channelId);
			expect(ensureMaterialized).not.toHaveBeenCalled();
			expect(synchronizer.channelFailure(channelId)).toBeNull();
		}
		finally {
			guide.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});

	it('materializes once when committed coverage is initially unavailable', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-playout-retry-'));
		const channelId = randomUUID();
		const channel = {
			...channelCreateSchema.parse({ number: '1', name: 'Retry' }),
			id: channelId,
			createdAt: '',
			updatedAt: '',
		};
		const ensureMaterialized = vi.fn(async () => undefined);
		const synchronizer = new PlayoutSynchronizer(
			{
				graphics: { assignments: () => new Map() }, getChannel: async () => channel,
				getPlaybackSettings: async () => playbackSettingsSchema.parse({ audioPreferences: { language: 'fr' } }),
				listPrograms: async () => [],
			} as unknown as Repository,
			root,
			'UTC',
			60,
			ensureMaterialized,
			{ resolve: async () => ({}) } as unknown as FallbackFillerStore,
			{ publish: vi.fn() } as LiveEventPublisher,
			loggerFixture(),
		);
		const guide = vi.spyOn(scheduleGuide, 'readCommittedChannelScheduleGuide')
			.mockRejectedValueOnce(new scheduleGuide.CommittedGuideUnavailableError(1))
			.mockResolvedValueOnce({
				timeZone: 'UTC',
				startDate: '2026-08-23',
				requestedDays: 1,
				days: 1,
				segmentLimitApplied: false,
				channels: [],
			} as ScheduleGuide);
		vi.spyOn(synchronizer.subtitles, 'prepare').mockResolvedValue(new Map());
		vi.spyOn(
			synchronizer as unknown as { channelFiles(): { files: Map<string, string>; usedGraphics: Map<string, number> } },
			'channelFiles',
		).mockReturnValue({ files: new Map(), usedGraphics: new Map() });
		try {
			await synchronizer.syncChannel(channelId);
			expect(ensureMaterialized).toHaveBeenCalledOnce();
			expect(synchronizer.channelFailure(channelId)).toBeNull();
		}
		finally {
			guide.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});
});

it.each(['ass', 'idx'])('retains referenced %s assets through a symlinked playback root and tolerates cleanup failures', async (extension) => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-playout-symlink-'));
	const actual = path.join(root, 'actual');
	const linked = path.join(root, 'linked');
	const channelId = randomUUID();
	await mkdir(path.join(actual, channelId, 'subtitles'), { recursive: true });
	await symlink(actual, linked);
	const retained = path.join(linked, channelId, 'subtitles', `retained.${extension}`);
	const paired = path.join(linked, channelId, 'subtitles', 'retained.sub');
	const obsolete = path.join(linked, channelId, 'subtitles', 'obsolete.ass');
	await writeFile(retained, 'retained');
	if (extension === 'idx') {
		await writeFile(paired, 'paired');
	}
	await writeFile(obsolete, 'obsolete');
	const configured = { ...channelCreateSchema.parse({ number: '1', name: 'Music', subtitleMode: 'convert' }), id: channelId, createdAt: '', updatedAt: '' };
	const logger = loggerFixture();
	const synchronizer = new PlayoutSynchronizer(
		{ graphics: { assignments: () => new Map() }, getChannel: async () => configured, getPlaybackSettings: async () => playbackSettingsSchema.parse({ audioPreferences: { language: 'fr' } }), listPrograms: async () => [] } as unknown as Repository,
		linked,
		'UTC',
		60,
		async () => undefined,
		{ resolve: async () => ({}) } as unknown as FallbackFillerStore,
		{ publish: vi.fn() } as LiveEventPublisher,
		logger,
	);
	const guide = vi.spyOn(scheduleGuide, 'readCommittedChannelScheduleGuide').mockResolvedValue({} as ScheduleGuide);
	const selections = new Map([['segment', [{ path: retained }]]]);
	vi.spyOn(synchronizer.subtitles, 'prepare')
		.mockResolvedValue(selections)
		.mockResolvedValueOnce(Object.assign(new Map(selections), { subtitleMode: 'burn' as const }));
	vi.spyOn(synchronizer as unknown as { channelFiles(): { files: Map<string, string>; usedGraphics: Map<string, number> } }, 'channelFiles').mockReturnValue({ files: new Map([['2026-09-09.json', JSON.stringify({ path: retained })]]), usedGraphics: new Map() });
	try {
		await synchronizer.syncChannel(channelId);
		await expect(readFile(retained, 'utf8')).resolves.toBe('retained');
		if (extension === 'idx') {
			await expect(readFile(paired, 'utf8')).resolves.toBe('paired');
		}

		await expect(access(obsolete)).rejects.toMatchObject({ code: 'ENOENT' });
		await synchronizer.syncChannel(channelId);
		await expect(readFile(retained, 'utf8')).resolves.toBe('retained');
		await rm(retained);
		await expect(synchronizer.syncChannel(channelId)).resolves.toBeTruthy();
		expect(synchronizer.channelFailure(channelId)).toBeNull();
		expect(logger.warn).toHaveBeenCalled();
		expect(synchronizer.subtitleMode(configured)).toBe('burn');
	}
	finally {
		guide.mockRestore();
		await rm(root, { recursive: true, force: true });
	}
});

it.each(['0.0.3', '0.0.4', '0.0.5'])('replaces %s playout while preserving media offsets, selected tracks, and fallback', async (version) => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-playout-upgrade-'));
	const channel = { ...channelCreateSchema.parse({ number: '1', name: 'Upgrade' }), id: randomUUID(), createdAt: '', updatedAt: '' };
	const segment = {
		id: randomUUID(), channelId: channel.id, role: 'primary', title: 'Movie',
		mediaItemId: randomUUID(), programId: null, playbackPath: '/media/movie.mkv',
		start: '2026-09-13T12:00:00Z', finish: '2026-09-13T12:01:00Z',
		sourceStartSeconds: 30, sourceFinishSeconds: 90,
	} as TimelineSegment;
	const guideValue = {
		timeZone: 'UTC', startDate: '2026-09-13', requestedDays: 1, days: 1, segmentLimitApplied: false,
		channels: [{ channelId: channel.id, preview: { segments: [segment] } }],
	} as ScheduleGuide;
	const synchronizer = new PlayoutSynchronizer(
		{
			graphics: { assignments: () => new Map() }, getChannel: async () => channel,
			getPlaybackSettings: async () => playbackSettingsSchema.parse({ audioPreferences: { language: 'fr' } }),
			listPrograms: async () => [],
			audioMetadata: async () => new Map([['/media/movie.mkv', { streams: [
				{ type: 'video', index: 0 }, { type: 'audio', index: 1, language: 'eng' },
				{ type: 'audio', index: 2, language: 'fra' },
			] }]]),
		} as unknown as Repository,
		root,
		'UTC',
		60,
		async () => {},
		{ resolve: async () => ({ path: '/fallback/custom.mp4', durationMilliseconds: 60_000, hasAudio: true }) } as unknown as FallbackFillerStore,
		{ publish: vi.fn() } as LiveEventPublisher,
		loggerFixture(),
	);
	const guide = vi.spyOn(scheduleGuide, 'readCommittedChannelScheduleGuide').mockResolvedValue(guideValue);
	vi.spyOn(synchronizer.subtitles, 'prepare').mockResolvedValue(new Map([[segment.id, [{ streamIndex: 4 }]]]));
	const streams = vi.spyOn(mediaStreams, 'prepareMediaStreams');
	try {
		const folder = await synchronizer.syncChannel(channel.id);
		const file = path.join(folder, (await readdir(folder)).find((name) => name.endsWith('.json'))!);
		const current = JSON.parse(await readFile(file, 'utf8'));
		await writeFile(file, JSON.stringify({ ...current, version: `https://ersatztv.org/playout/version/${version}` }));

		await synchronizer.syncChannel(channel.id);
		const updated = JSON.parse(await readFile(file, 'utf8'));
		expect(streams).toHaveBeenCalledWith(expect.anything(), channel, guideValue, [], { language: 'fr' });
		expect(updated.version).toBe(ETV_PLAYOUT_VERSION);
		expect(updated.items.length).toBeGreaterThan(0);
		expect(updated.items).toEqual(current.items);
		expect(updated.items[0].source.path).toBe('/fallback/custom.mp4');
		expect(updated.items.find((item: { source: { path: string } }) => item.source.path === segment.playbackPath))
			.toMatchObject({
				source: { in_point_ms: 30_000, out_point_ms: 90_000 },
				tracks: { audio: { stream_index: 2 }, video: { stream_index: 0 }, subtitle: { stream_index: 4 } },
			});
	}
	finally {
		guide.mockRestore();
		streams.mockRestore();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);

it('reclaims completed graphics during playback while retaining a replaced item that is still in flight', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-graphics-lease-'));
	const channel = { ...channelCreateSchema.parse({ number: '1', name: 'Graphics' }), id: randomUUID(), createdAt: '', updatedAt: '' };
	const repository = { graphics: { assignments: () => new Map(), preparePresets: () => new Map() }, getChannel: async () => channel, listPrograms: async () => [], getPlaybackSettings: async () => playbackSettingsSchema.parse({}) } as unknown as Repository;
	const synchronizer = new PlayoutSynchronizer(repository, root, 'UTC', 60, async () => {},
		{ resolve: async () => null } as unknown as FallbackFillerStore,
		{ publish: vi.fn() } as LiveEventPublisher, loggerFixture());
	const guide = vi.spyOn(scheduleGuide, 'readCommittedChannelScheduleGuide').mockResolvedValue({ channels: [{ preview: { segments: [{ id: randomUUID(), role: 'primary' }] } }] } as ScheduleGuide);
	const streams = vi.spyOn(mediaStreams, 'prepareMediaStreams').mockResolvedValue({ audio: new Map(), video: new Map() });
	vi.spyOn(synchronizer.subtitles, 'prepare').mockResolvedValue(new Map());
	const graphics = path.join(synchronizer.channelFolder(channel.id), 'graphics');
	const expired = path.join(graphics, 'a'.repeat(64) + '.png');
	const retained = path.join(graphics, 'b'.repeat(64) + '.png');
	const unleased = path.join(graphics, 'c'.repeat(64) + '.png');
	const warmed = path.join(graphics, 'd'.repeat(64) + '.png');
	const files = new Map<string, string>();
	const publish = vi.spyOn(synchronizer as unknown as { channelFiles(): { files: Map<string, string>; usedGraphics: Map<string, number> } }, 'channelFiles');
	let cursor: number | undefined;
	synchronizer.consumerActive = () => true;
	synchronizer.consumerProgress = () => cursor;
	try {
		await mkdir(graphics, { recursive: true });
		await Promise.all([writeFile(expired, 'expired'), writeFile(retained, 'retained')]);
		publish.mockReturnValueOnce({ files, usedGraphics: new Map([[expired, 1000], [retained, 3000]]) });
		await synchronizer.syncChannel(channel.id);

		channel.graphicsPresetId = randomUUID();
		await Promise.all([writeFile(unleased, 'unpublished'), writeFile(warmed, 'late render')]);
		const retries = (synchronizer as unknown as {
			graphicsRetries: Map<string, { pending: Map<string, Promise<void>>; warmed: Set<string> }>;
		}).graphicsRetries;
		retries.set(channel.id, { pending: new Map(), warmed: new Set([path.basename(warmed)]) });
		publish.mockReturnValue({ files, usedGraphics: new Map() });
		await synchronizer.syncChannel(channel.id);
		await expect(access(unleased)).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(access(warmed)).resolves.toBeUndefined();
		await expect(access(expired)).resolves.toBeUndefined();
		await expect(access(retained)).resolves.toBeUndefined();

		cursor = 1000;
		await synchronizer.syncChannel(channel.id);
		await expect(access(expired)).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(access(warmed)).resolves.toBeUndefined();
		retries.get(channel.id)!.warmed.delete(path.basename(warmed));
		await expect(access(retained)).resolves.toBeUndefined();

		cursor = 3000;
		await synchronizer.syncChannel(channel.id);
		await expect(access(warmed)).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(access(retained)).rejects.toMatchObject({ code: 'ENOENT' });
	}
	finally {
		guide.mockRestore();
		streams.mockRestore();
		await rm(root, { recursive: true, force: true });
	}
});
