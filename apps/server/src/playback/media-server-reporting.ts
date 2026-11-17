import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { parseRemotePlaybackReference, type TimelineSegment } from '@moirai/shared';
import { createMediaFetch, type MediaFetch } from '../media-servers/http.js';
import { JellyfinPlaybackClient, type JellyfinPlaybackEvent } from '../media-servers/jellyfin-playback-client.js';
import { PlexPlaybackClient, PLEX_REPORT_INTERVAL_MS } from '../media-servers/plex-playback-client.js';
import type { Repository } from '../repository/index.js';
import type { MediaServerConnectionRecord } from '../repository/media-servers.js';

/** Progress cadence, also bounding discovery of a newly enabled reporting setting. */
export const PLAYBACK_REPORT_INTERVAL_MS = 15_000;

/** Ready channel with recent downstream activity, independent of viewer identity or count. */
export interface ReportingChannel {
	id: string;
	number: string;
	name: string;
}

/** Source part and broadcast interval used to derive live positions without FFmpeg read-ahead. */
interface ReportingTarget {
	key: string;
	serverId: string;
	itemId: string;
	mediaSourceId: string;
	segment: TimelineSegment;
	partStartSeconds: number;
	finishMs: number;
	durationMilliseconds?: number;
}

/** One logical airing retained across progress reports, seeks, and upstream HTTP reconnects. */
interface ReportedPlayback {
	target: ReportingTarget;
	connection: MediaServerConnectionRecord;
	client: JellyfinPlaybackClient | PlexPlaybackClient;
	playSessionId: string;
}

/** Resolve the file at the channel's live source position, including cropped multipart spans. */
function targetAt(segment: TimelineSegment, nowMs: number): ReportingTarget | null {
	if (segment.role === 'dead-air' || !segment.playbackPath) {
		return null;
	}

	const elapsedSeconds = Math.max(0, (nowMs - Date.parse(segment.start)) / 1_000);
	const sourceSeconds = segment.sourceStartSeconds + elapsedSeconds;
	const parts = segment.playbackParts?.length ? segment.playbackParts : [{
		playbackPath: segment.playbackPath,
		durationSeconds: Infinity,
	}];
	let partStartSeconds = 0;
	for (const part of parts) {
		const partEndSeconds = partStartSeconds + part.durationSeconds;
		if (sourceSeconds < partEndSeconds) {
			const remote = parseRemotePlaybackReference(part.playbackPath);
			if (!remote) {
				return null;
			}

			const [itemId, ...source] = remote.partId.split(':');
			return {
				key: `${segment.id}:${remote.mediaServerId}:${remote.partId}`,
				serverId: remote.mediaServerId,
				itemId: itemId!,
				mediaSourceId: source.join(':') || itemId!,
				segment,
				partStartSeconds,
				finishMs: Math.min(
					Date.parse(segment.finish),
					Date.parse(segment.start) + (partEndSeconds - segment.sourceStartSeconds) * 1_000,
				),
			};
		}
		partStartSeconds = partEndSeconds;
	}
	return null;
}

/**
 * Derive the live source position, clamped at the airing's boundary and relative to its item or file.
 */
function positionSeconds(target: ReportingTarget, nowMs: number): number {
	const endMs = Math.min(nowMs, target.finishMs);
	const elapsedSeconds = Math.max(0, (endMs - Date.parse(target.segment.start)) / 1_000);
	const sourceSeconds = Math.min(
		target.segment.sourceStartSeconds + elapsedSeconds,
		target.segment.sourceFinishSeconds ?? Infinity,
	);
	return Math.max(0, sourceSeconds - target.partStartSeconds);
}

/** Restart reporting only when its credential, destination, device identity, or TLS choice changes. */
function sameConnection(left: MediaServerConnectionRecord, right: MediaServerConnectionRecord | undefined): boolean {
	return Boolean(right
		&& left.provider === right.provider
		&& left.baseUrl === right.baseUrl
		&& left.accessToken === right.accessToken
		&& left.clientIdentifier === right.clientIdentifier
		&& left.allowInsecureTls === right.allowInsecureTls);
}

/**
 * Observe shared, ready channel workers without adding work to HLS requests or tune startup.
 * A single timer batches opted-in connections and committed live segments, then reports channels
 * independently. State stays in memory; failures never block playback or build a retry backlog.
 */
export class MediaServerPlaybackReporter {
	private readonly playbacks = new Map<string, ReportedPlayback>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pending: Promise<void> | undefined;
	private running = false;
	private wakeRequested = false;
	private nextDelay = PLAYBACK_REPORT_INTERVAL_MS;
	private readonly abort = new AbortController();

	constructor(
		private readonly repository: Pick<Repository, 'mediaServers' | 'listCurrentPlaybackSegments'>,
		private readonly channels: () => ReportingChannel[],
		private readonly logger: FastifyBaseLogger,
		private readonly fetchFor: (insecure: boolean) => MediaFetch = createMediaFetch,
	) {}

	/** Begin background observation; no metadata or reporting request is awaited by playback. */
	start(): void {
		this.running = true;
		this.wake();
	}

	/** Coalesce worker readiness and exit notifications with the existing background sweep. */
	wake(): void {
		if (!this.running) {
			return;
		}

		clearTimeout(this.timer);
		if (this.pending) {
			this.wakeRequested = true;
			return;
		}
		this.schedule(0);
	}

	/** Cancel in-flight observation and send one best-effort stop for each reported channel. */
	async close(): Promise<void> {
		this.running = false;
		clearTimeout(this.timer);
		this.abort.abort();
		await this.pending;
		await Promise.all([...this.playbacks.entries()].map(async ([channelId, playback]) => {
			this.playbacks.delete(channelId);
			await this.send(channelId, playback, 'stop', Date.now());
		}));
	}

	/** Serialize sweeps so a slow provider cannot accumulate progress requests or reorder events. */
	refresh(): Promise<void> {
		if (this.pending) {
			return this.pending;
		}

		this.nextDelay = PLAYBACK_REPORT_INTERVAL_MS;
		this.pending = this.sweep().catch(() => {
			this.logger.warn('Media-server playback observation failed');
		}).finally(() => {
			this.pending = undefined;
			if (this.running) {
				this.schedule(this.wakeRequested ? 0 : this.nextDelay);
			}
			this.wakeRequested = false;
		});
		return this.pending;
	}

	/** Keep at most one unreferenced timer, waking at an airing boundary when it comes first. */
	private schedule(delay: number): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.refresh(), delay);
		this.timer.unref();
	}

	/** Load settings and live programming only while channels or outstanding reports exist. */
	private async sweep(): Promise<void> {
		const channels = this.channels();
		if (channels.length === 0 && this.playbacks.size === 0) {
			return;
		}

		const connections = await this.repository.mediaServers.playbackReportingConnections();
		const nowMs = Date.now();
		const records = channels.length && connections.length
			? await this.repository.listCurrentPlaybackSegments(new Date(nowMs).toISOString(), channels.map(channel => channel.id))
			: [];
		const connectionsById = new Map(connections.map(connection => [connection.id, connection]));

		// Plex file requests use part ids; resolve rating keys together without querying per channel.
		const plexIds = records.flatMap(({ segment }) => {
			const target = targetAt(segment, nowMs);
			return target && connectionsById.get(target.serverId)?.provider === 'plex' && segment.mediaItemId
				? [segment.mediaItemId] : [];
		});
		const plexItems = plexIds.length ? await this.repository.mediaServers.plexPlaybackItems([...new Set(plexIds)]) : [];
		const plexItemsById = new Map(plexItems.map(item => [item.id, item]));
		if (plexIds.length) {
			this.nextDelay = PLEX_REPORT_INTERVAL_MS;
		}

		const recordsByChannel = new Map(records.map(record => [record.segment.channelId, record.segment]));
		const channelsById = new Map(channels.map(channel => [channel.id, channel]));
		const ids = new Set([...channelsById.keys(), ...this.playbacks.keys()]);

		// Channel reports run independently; a failed server does not stall other channels.
		await Promise.all([...ids].map(async (id) => {
			const channel = channelsById.get(id);
			const segment = recordsByChannel.get(id);
			let target = channel && segment ? targetAt(segment, nowMs) : null;
			const connection = target ? connectionsById.get(target.serverId) : undefined;
			if (target && segment && connection?.provider === 'plex') {
				const item = plexItemsById.get(segment.mediaItemId ?? '');
				// Plex timelines are item-relative, even when an airing spans several physical files.
				target = item?.serverId === target.serverId && item.durationMilliseconds && item.durationMilliseconds > 0 ? {
					...target,
					key: `${segment.id}:${target.serverId}:${item.ratingKey}`,
					itemId: item.ratingKey,
					partStartSeconds: 0,
					finishMs: Date.parse(segment.finish),
					durationMilliseconds: item.durationMilliseconds,
				} : null;
			}
			const boundaryMs = target?.finishMs ?? (segment ? Date.parse(segment.finish) : Infinity);
			await this.update(id, channel, target, connection);
			this.nextDelay = Math.min(this.nextDelay, Math.max(1, boundaryMs - Date.now()));
		}));
	}

	/** Stop a former airing before starting its replacement under the same channel device. */
	private async update(
		channelId: string,
		channel: ReportingChannel | undefined,
		target: ReportingTarget | null,
		connection: MediaServerConnectionRecord | undefined,
	): Promise<void> {
		let current = this.playbacks.get(channelId);
		if (current && (current.target.key !== target?.key || !sameConnection(current.connection, connection))) {
			this.playbacks.delete(channelId);
			await this.send(channelId, current, 'stop', Date.now());
			current = undefined;
		}
		if (this.abort.signal.aborted || !channel || !target || !connection || target.finishMs <= Date.now()) {
			return;
		}

		// Retain ownership even after an ambiguous timeout; never repeatedly increment play counts.
		const event = current ? 'progress' : 'start';
		if (!current) {
			current = {
				target,
				connection,
				client: connection.provider === 'plex'
					? new PlexPlaybackClient(this.fetchFor(connection.allowInsecureTls), connection, channel)
					: new JellyfinPlaybackClient(this.fetchFor(connection.allowInsecureTls), connection, channel),
				playSessionId: randomUUID(),
			};
			this.playbacks.set(channelId, current);
		}
		current.target = target;
		await this.send(channelId, current, event, Date.now(), this.abort.signal);
	}

	/** Log only channel id, event, and fixed text; provider exceptions may contain credentials. */
	private async send(
		channelId: string,
		playback: ReportedPlayback,
		event: JellyfinPlaybackEvent,
		nowMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		try {
			if (playback.client instanceof PlexPlaybackClient) {
				await playback.client.report(event, {
					ratingKey: playback.target.itemId,
					sessionId: playback.playSessionId,
					positionMilliseconds: Math.round(positionSeconds(playback.target, nowMs) * 1_000),
					durationMilliseconds: playback.target.durationMilliseconds!,
				}, signal);
			}
			else {
				await playback.client.report(event, {
					ItemId: playback.target.itemId,
					MediaSourceId: playback.target.mediaSourceId,
					PlaySessionId: playback.playSessionId,
					PositionTicks: Math.round(positionSeconds(playback.target, nowMs) * 10_000_000),
				}, signal);
			}
		}
		catch {
			this.logger.warn({ channelId, event, provider: playback.connection.provider }, 'Media-server playback report failed');
		}
	}
}
