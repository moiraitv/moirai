import { createHash } from 'node:crypto';
import type { MediaServerConnection } from './items.js';
import type { MediaFetch } from './http.js';
import { mediaServerUrl, MediaServerRequestError } from './http.js';
import { jellyfinAuthHeaders } from './jellyfin-auth.js';

/** Reports have a short deadline independent of media reads and tune readiness. */
export const JELLYFIN_REPORT_TIMEOUT_MS = 3_000;

/** Item identity and live source position shared by the three playback reports. */
export interface JellyfinPlaybackReport {
	ItemId: string;
	MediaSourceId: string;
	PlaySessionId: string;
	PositionTicks: number;
}

/** Playback lifecycle endpoints supported by Jellyfin. */
export type JellyfinPlaybackEvent = 'start' | 'progress' | 'stop';

/**
 * Send operational playback reports under a stable, separate device for each channel.
 * Jellyfin receives the original file directly; downstream Moirai transcoding is not attributed
 * to Jellyfin. No remote-control capabilities are advertised for the IPTV channel.
 */
export class JellyfinPlaybackClient {
	private readonly headers: Record<string, string>;

	constructor(
		private readonly fetch: MediaFetch,
		private readonly connection: MediaServerConnection,
		channel: { id: string; number: string; name: string },
	) {
		const clientIdentifier = createHash('sha256')
			.update(connection.clientIdentifier).update('\0').update(channel.id).digest('hex');
		// Jellyfin decodes header values; percent-encoding preserves names without header delimiters.
		const device = encodeURIComponent(`Moirai · ${channel.number} ${channel.name}`
			.replace(/\p{Cc}/gu, ' ').slice(0, 120).trim());
		this.headers = {
			...jellyfinAuthHeaders({ ...connection, clientIdentifier }, connection.accessToken, device),
			'Content-Type': 'application/json',
		};
	}

	/** Send one bounded report, discard its body, and expose only credential-safe errors. */
	async report(event: JellyfinPlaybackEvent, report: JellyfinPlaybackReport, signal?: AbortSignal): Promise<void> {
		const suffix = event === 'start' ? '' : event === 'progress' ? '/Progress' : '/Stopped';
		const deadline = AbortSignal.timeout(JELLYFIN_REPORT_TIMEOUT_MS);
		const response = await this.fetch(mediaServerUrl(this.connection.baseUrl, `/Sessions/Playing${suffix}`), {
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify({
				...report,
				...(event === 'stop' ? {} : { CanSeek: false, IsPaused: false, PlayMethod: 'DirectPlay' }),
			}),
			signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
		});
		await response.body?.cancel();
		if (!response.ok) {
			throw new MediaServerRequestError(`Jellyfin playback report returned HTTP ${response.status}`, response.status);
		}
	}
}
