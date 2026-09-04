import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import type { FastifyBaseLogger } from 'fastify';
import { XMLTV_EPG_DAYS, type Channel, type LiveEvent } from '@moirai/shared';
import { buildEtvPlayoutFiles } from './playout-output.js';
import type { FallbackFillerStore } from './fallback-filler-store.js';
import type { LiveEventPublisher } from '../operations/live-events.js';
import type { Repository } from '../repository/index.js';
import { readCommittedChannelScheduleGuide } from '../guide/schedule-guide.js';
import { currentTimestamp } from '../time.js';

/** File names accepted inside Moirai's private playout directories. */
const PLAYOUT_FILENAME
	= /^\d{8}T\d{6}\.\d{9}[+-]\d{4}_\d{8}T\d{6}\.\d{9}[+-]\d{4}\.json$/;
/** Stable channel identifiers accepted as private directory names. */
const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Public synchronization health used by playback readiness. */
export interface PlayoutSynchronizationHealth {
	status: 'ready' | 'degraded';
	detail?: string;
}

/** Safe per-channel playout failure exposed through playback status. */
export interface PlayoutSynchronizationFailure {
	message: string;
	failedAt: string;
}

/**
 * Materialize committed rolling timelines as validated daily ErsatzTV playout documents. The
 * synchronizer coalesces per-channel writes, atomically replaces output, removes deleted-channel
 * state, and exposes failures to playback readiness.
 */
export class PlayoutSynchronizer {
	private readonly active = new Map<string, Promise<string>>();
	private readonly pending = new Set<string>();
	private readonly failures = new Map<string, PlayoutSynchronizationFailure>();
	private timer: NodeJS.Timeout | null = null;
	private running = false;

	constructor(
		private readonly repository: Repository,
		private readonly root: string,
		private readonly timeZone: string,
		private readonly intervalSeconds: number,
		private readonly ensureMaterialized: () => Promise<void>,
		private readonly fallbackFillers: FallbackFillerStore,
		private readonly events: LiveEventPublisher,
		private readonly logger: FastifyBaseLogger,
	) {}

	/** Start periodic synchronization and an immediate initial pass. */
	start(): void {
		if (this.running) {
			return;
		}

		this.running = true;
		void this.syncAll().finally(() => this.schedule());
	}

	/** Stop future passes and wait for active channel writes. */
	async close(): Promise<void> {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		await Promise.allSettled(this.active.values());
	}

	/** Report whether every configured channel has current private playout output. */
	health(): PlayoutSynchronizationHealth {
		if (!this.running) {
			return { status: 'degraded', detail: 'Playout synchronization is not running' };
		}

		if (this.failures.size > 0) {
			return {
				status: 'degraded',
				detail: `${this.failures.size} channel playout${this.failures.size === 1 ? '' : 's'} could not be synchronized`,
			};
		}

		return { status: 'ready' };
	}

	/** Synchronize affected channels after authoritative schedule or presentation changes. */
	handleEvent(event: LiveEvent): void {
		if (event.type === 'timeline.changed' && event.data.status === 'ready') {
			void this.syncChannel(event.data.channelId).catch(() => undefined);
		}
		else if (event.type === 'channel.changed' && event.data.change !== 'deleted') {
			void this.syncChannel(event.data.channelId).catch(() => undefined);
		}
		else if (event.type === 'channel.changed') {
			void this.removeChannel(event.data.channelId).catch(() => undefined);
		}
	}

	/** Return the private absolute playout folder for one stable channel identity. */
	channelFolder(channelId: string): string {
		if (!CHANNEL_ID.test(channelId)) {
			throw new Error('Invalid channel identity');
		}

		return path.join(this.root, channelId);
	}

	/** Remove private playout files after their channel is deleted. */
	async removeChannel(channelId: string): Promise<void> {
		await this.active.get(channelId)?.catch(() => undefined);
		this.failures.delete(channelId);
		await rm(this.channelFolder(channelId), { recursive: true, force: true });
	}

	/** Return a safe failure message for one channel, if its latest sync failed. */
	channelFailure(channelId: string): string | null {
		return this.failures.get(channelId)?.message ?? null;
	}

	/** Return a copy of current channel failures for operator status. */
	channelFailures(): Map<string, PlayoutSynchronizationFailure> {
		return new Map(this.failures);
	}

	/** Ensure one channel's current rolling window exists on disk. */
	syncChannel(channelId: string): Promise<string> {
		const existing = this.active.get(channelId);
		if (existing) {
			this.pending.add(channelId);
			return existing;
		}

		const operation = Promise.resolve().then(() => this.performQueuedChannelSync(channelId));
		this.active.set(channelId, operation);
		return operation;
	}

	/** Synchronize every channel while isolating channel-specific failures. */
	async syncAll(): Promise<void> {
		await this.ensureMaterialized().catch(() => undefined);
		const channels = await this.repository.listChannels();
		const channelIds = new Set(channels.map((channel) => channel.id));
		for (const entry of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
			if (entry.isDirectory() && CHANNEL_ID.test(entry.name) && !channelIds.has(entry.name)) {
				await this.removeChannel(entry.name).catch((error) => {
					this.logger.warn(
						{ error, channelId: entry.name },
						'Orphaned private channel playout cleanup failed',
					);
				});
			}
		}
		await this.fallbackFillers.reconcileChannels(channelIds).catch((error) => {
			this.logger.warn({ error }, 'Orphaned fallback filler cleanup failed');
		});
		for (const channel of channels) {
			await this.syncChannel(channel.id).catch(() => undefined);
		}
	}

	/** Repeat one channel pass when an invalidation arrives during its active write. */
	private async performQueuedChannelSync(channelId: string): Promise<string> {
		let folder: string | null = null;
		let failed = false;
		let failure: unknown;
		try {
			do {
				this.pending.delete(channelId);
				try {
					folder = await this.performChannelSync(channelId);
					failed = false;
					failure = undefined;
				}
				catch (error) {
					failed = true;
					failure = error;
				}
			}
			while (this.pending.has(channelId));
			if (failed) {
				throw failure;
			}
			if (!folder) {
				throw new Error('Playout synchronization completed without an output folder');
			}

			this.failures.delete(channelId);
			this.active.delete(channelId);
			this.events.publish({
				type: 'playback.changed',
				data: { channelId, reason: 'playout-synced' },
			});
			return folder;
		}
		catch (error) {
			const firstFailure = !this.failures.has(channelId);
			this.failures.set(channelId, {
				message: 'Committed playout is not ready',
				failedAt: currentTimestamp(),
			});
			this.active.delete(channelId);
			if (firstFailure) {
				this.logger.error({ error, channelId }, 'Private channel playout synchronization failed');
				this.events.publish({
					type: 'playback.changed',
					data: { channelId, reason: 'failed' },
				});
			}
			throw error;
		}
	}

	/** Schedule the next rolling-window reconciliation. */
	private schedule(): void {
		if (!this.running || this.timer) {
			return;
		}

		this.timer = setTimeout(() => {
			this.timer = null;
			void this.syncAll().finally(() => this.schedule());
		}, this.intervalSeconds * 1_000);
		this.timer.unref();
	}

	/** Build and atomically replace one channel's complete daily document set. */
	private async performChannelSync(channelId: string): Promise<string> {
		await this.ensureMaterialized();
		const channel = await this.repository.getChannel(channelId);
		if (!channel) {
			throw new Error('Channel not found');
		}

		const startDate = Temporal.Now.plainDateISO(this.timeZone).toString();
		const guide = await readCommittedChannelScheduleGuide(
			this.repository,
			this.timeZone,
			channel.id,
			startDate,
			XMLTV_EPG_DAYS,
		);
		const fallback = await this.fallbackFillers.resolve(channel.id);
		await mkdir(this.root, { recursive: true });
		const resolvedRoot = await realpath(this.root);
		const folder = this.channelFolder(channel.id);
		await mkdir(folder, { recursive: true });
		const resolvedFolder = await realpath(folder);
		if (!resolvedFolder.startsWith(`${resolvedRoot}${path.sep}`)) {
			throw new Error('Playback output directory is outside its configured root');
		}
		const generated = this.channelFiles(channel, guide, fallback);

		for (const [filename, content] of generated) {
			const destination = path.join(resolvedFolder, filename);
			try {
				const existing = await lstat(destination);
				const unchanged
					= existing.isFile()
						&& !existing.isSymbolicLink()
						&& await readFile(destination, 'utf8') === content;
				if (unchanged) {
					continue;
				}
			}
			catch {
				// A missing or unreadable destination is replaced atomically below.
			}
			const temporary = `${destination}.tmp-${randomUUID()}`;
			try {
				await writeFile(temporary, content, { mode: 0o644 });
				await rename(temporary, destination);
			}
			catch (error) {
				await unlink(temporary).catch(() => undefined);
				throw error;
			}
		}
		const current = new Set(generated.keys());
		for (const entry of await readdir(resolvedFolder, { withFileTypes: true })) {
			if (entry.isFile() && PLAYOUT_FILENAME.test(entry.name) && !current.has(entry.name)) {
				await unlink(path.join(resolvedFolder, entry.name));
			}
		}
		return resolvedFolder;
	}

	/** Build validated daily files from the generated channel playout paths. */
	private channelFiles(
		channel: Channel,
		guide: Awaited<ReturnType<typeof readCommittedChannelScheduleGuide>>,
		fallback: Awaited<ReturnType<FallbackFillerStore['resolve']>>,
	): Map<string, string> {
		const files = new Map<string, string>();
		for (const [relativePath, content] of buildEtvPlayoutFiles(
			[channel],
			guide,
			new Map([[channel.id, fallback]]),
		)) {
			const filename = path.posix.basename(relativePath);
			if (!PLAYOUT_FILENAME.test(filename)) {
				throw new Error('Generated an invalid playout filename');
			}

			files.set(filename, content);
		}
		return files;
	}
}
