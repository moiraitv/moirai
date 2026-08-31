import type {
	PlaybackClientStatus,
	PlaybackSessionAcceleration,
} from '@moirai/shared';

/** Maximum client identities retained for one shared channel worker. */
const MAX_SESSION_CLIENTS = 16;
/** Viewer activity window aligned with the integrated worker heartbeat timeout. */
const ACTIVE_CLIENT_WINDOW_MS = 90_000;
/** Maximum server-visible network-address length retained in status. */
const MAX_CLIENT_ADDRESS_LENGTH = 128;
/** Maximum User-Agent length retained in status. */
const MAX_CLIENT_USER_AGENT_LENGTH = 512;

/** Untrusted request information available to identify one IPTV client. */
export interface PlaybackClientObservation {
	address: string;
	userAgent: string | null;
}

/** Transient identity result used to deduplicate one anonymous tune session. */
export interface PlaybackClientActivity {
	key: string;
	started: boolean;
}

/** Client record with numeric activity time retained only inside the playback engine. */
interface TrackedPlaybackClient extends PlaybackClientStatus {
	lastSeenMs: number;
}

/** Remove control characters and bound one client-provided status value. */
function normalizeClientValue(value: string, maximumLength: number): string {
	const printable = [...value].map((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 32 || codePoint === 127 ? ' ' : character;
	}).join('');
	return printable
		.trim()
		.slice(0, maximumLength);
}

/** Convert one actual FFmpeg output encoder into the acceleration used for that item. */
function accelerationFromEncoder(encoder: string): PlaybackSessionAcceleration | null {
	if (encoder === 'copy' || encoder === 'libx264' || encoder === 'libx265') {
		return 'none';
	}

	const suffixes: Array<[string, PlaybackSessionAcceleration]> = [
		['_amf', 'amf'],
		['_nvenc', 'cuda'],
		['_qsv', 'qsv'],
		['_rkmpp', 'rkmpp'],
		['_vaapi', 'vaapi'],
		['_videotoolbox', 'videotoolbox'],
		['_vulkan', 'vulkan'],
	];
	return suffixes.find(([suffix]) => encoder.endsWith(suffix))?.[1] ?? null;
}

/** Read the effective video encoder from one worker optimized-pipeline diagnostic line. */
export function accelerationFromWorkerLine(line: string): PlaybackSessionAcceleration | null {
	if (!line.includes('optimized pipeline:')) {
		return null;
	}

	const encoder = /(?:^|\s)-vcodec\s+([^\s]+)/u.exec(line)?.[1];
	return encoder ? accelerationFromEncoder(encoder) : null;
}

/** Track a bounded set of recently active clients for one shared channel worker. */
export class PlaybackClientTracker {
	private readonly clients = new Map<string, TrackedPlaybackClient>();

	/** Record one playlist or segment request using only sanitized server-visible identity data. */
	observe(observation: PlaybackClientObservation, nowMs = Date.now()): PlaybackClientActivity {
		const address = normalizeClientValue(
			observation.address,
			MAX_CLIENT_ADDRESS_LENGTH,
		) || 'Unknown address';
		const normalizedUserAgent = observation.userAgent
			? normalizeClientValue(observation.userAgent, MAX_CLIENT_USER_AGENT_LENGTH)
			: '';
		const userAgent = normalizedUserAgent || null;
		const key = `${address}\0${userAgent ?? ''}`;
		const timestamp = new Date(nowMs).toISOString();
		this.prune(nowMs);
		const current = this.clients.get(key);
		if (current) {
			current.lastSeenAt = timestamp;
			current.lastSeenMs = nowMs;
			return { key, started: false };
		}

		if (this.clients.size >= MAX_SESSION_CLIENTS) {
			const oldest = [...this.clients.entries()].sort(
				((left, right) => left[1].lastSeenMs - right[1].lastSeenMs),
			)[0]?.[0];
			if (oldest) {
				this.clients.delete(oldest);
			}
		}
		this.clients.set(key, {
			address,
			userAgent,
			firstSeenAt: timestamp,
			lastSeenAt: timestamp,
			lastSeenMs: nowMs,
		});
		return { key, started: true };
	}

	/** Return currently active clients ordered by their most recent request. */
	active(nowMs = Date.now()): PlaybackClientStatus[] {
		this.prune(nowMs);
		return [...this.clients.values()]
			.sort((left, right) => right.lastSeenMs - left.lastSeenMs)
			.map(({ address, userAgent, firstSeenAt, lastSeenAt }) => ({
				address,
				userAgent,
				firstSeenAt,
				lastSeenAt,
			}));
	}

	/** Remove viewers whose last request is older than the worker heartbeat window. */
	private prune(nowMs: number): void {
		const cutoff = nowMs - ACTIVE_CLIENT_WINDOW_MS;
		for (const [key, client] of this.clients) {
			if (client.lastSeenMs < cutoff) {
				this.clients.delete(key);
			}
		}
	}
}
