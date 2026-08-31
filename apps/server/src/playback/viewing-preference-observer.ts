import type { FastifyBaseLogger } from 'fastify';
import type { Repository } from '../repository/index.js';
import type { MaterializedSegmentRecord } from '../repository/contracts.js';
import type { PlaybackClientActivity } from './session-observability.js';

/** Minimum continuous observation of one item before it represents a viewing choice. */
const QUALIFICATION_MS = 120_000;
/** Keep preference encounters aligned with bounded playback-client observability. */
const ACTIVE_CLIENT_WINDOW_MS = 90_000;
/** Maximum transient client encounters retained for one channel. */
const MAX_CHANNEL_CLIENTS = 16;

/** Pending or completed item encounter for one transient client identity. */
interface ViewingEncounter {
	segmentId: string;
	mediaItemId: string;
	type: 'initial' | 'continued';
	firstObservedMs: number;
	lastObservedMs: number;
	scored: boolean;
}

/** Cache entry that prevents an HLS-request query for every client request. */
interface CurrentSegmentCache {
	record: MaterializedSegmentRecord | null;
	validUntilMs: number;
}

/** Observe qualified channel viewing without persisting client identity. */
export class ViewingPreferenceObserver {
	private readonly encounters = new Map<string, Map<string, ViewingEncounter>>();
	private readonly segmentCache = new Map<string, CurrentSegmentCache>();
	private readonly queues = new Map<string, Promise<void>>();

	constructor(
		private readonly repository: Repository,
		private readonly logger: FastifyBaseLogger,
		private enabled: boolean,
	) {}

	/** Enable or disable both preference collection and application. */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.encounters.clear();
		}
	}

	/** Queue one request observation so concurrent segment requests cannot double-score an item. */
	observe(channelId: string, client: PlaybackClientActivity, nowMs = Date.now()): void {
		if (!this.enabled) {
			return;
		}

		const prior = this.queues.get(channelId) ?? Promise.resolve();
		const next = prior
			.then(() => this.observeSerial(channelId, client, nowMs))
			.catch((error) => this.logger.warn({ error, channelId }, 'Viewing preference observation failed'));
		this.queues.set(channelId, next);
		void next.finally(() => {
			if (this.queues.get(channelId) === next) {
				this.queues.delete(channelId);
			}
		});
	}

	/** Resolve the current materialized item and advance one client encounter. */
	private async observeSerial(
		channelId: string,
		client: PlaybackClientActivity,
		nowMs: number,
	): Promise<void> {
		const record = await this.currentSegment(channelId, nowMs);
		if (!record?.segment.mediaItemId || record.segment.role === 'dead-air') {
			return;
		}

		let clients = this.encounters.get(channelId);
		if (!clients) {
			clients = new Map();
			this.encounters.set(channelId, clients);
		}
		for (const [key, candidate] of clients) {
			if (candidate.lastObservedMs < nowMs - ACTIVE_CLIENT_WINDOW_MS) {
				clients.delete(key);
			}
		}
		let encounter = clients.get(client.key);
		if (client.started || !encounter || encounter.segmentId !== record.segment.id) {
			if (!clients.has(client.key) && clients.size >= MAX_CHANNEL_CLIENTS) {
				const oldest = [...clients.entries()].sort(
					((left, right) => left[1].lastObservedMs - right[1].lastObservedMs),
				)[0]?.[0];
				if (oldest) {
					clients.delete(oldest);
				}
			}
			encounter = {
				segmentId: record.segment.id,
				mediaItemId: record.segment.mediaItemId,
				type: client.started || !encounter ? 'initial' : 'continued',
				firstObservedMs: nowMs,
				lastObservedMs: nowMs,
				scored: false,
			};
			clients.set(client.key, encounter);
		}
		else {
			encounter.lastObservedMs = nowMs;
		}
		if (encounter.scored || nowMs - encounter.firstObservedMs < QUALIFICATION_MS) {
			return;
		}

		encounter.scored = true;
		this.repository.recordViewingPreference(
			encounter.mediaItemId,
			encounter.type === 'initial' ? 2 : 1,
			encounter.type,
			new Date(nowMs).toISOString(),
		);
	}

	/** Return the current segment while caching it exactly to its committed finish time. */
	private async currentSegment(
		channelId: string,
		nowMs: number,
	): Promise<MaterializedSegmentRecord | null> {
		const cached = this.segmentCache.get(channelId);
		if (cached && nowMs < cached.validUntilMs) {
			return cached.record;
		}

		const at = new Date(nowMs).toISOString();
		const records = await this.repository.listMaterializedTimelineSegments(
			at,
			new Date(nowMs + 1).toISOString(),
			channelId,
		);
		const record = records[0] ?? null;
		this.segmentCache.set(channelId, {
			record,
			validUntilMs: record ? Date.parse(record.segment.finish) : nowMs + 5_000,
		});
		return record;
	}
}
