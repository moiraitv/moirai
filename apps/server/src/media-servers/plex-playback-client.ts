import { createHash } from 'node:crypto';
import type { MediaServerConnection } from './items.js';
import type { MediaFetch } from './http.js';
import { mediaServerUrl, MediaServerRequestError } from './http.js';
import { plexAuthHeaders } from './plex-auth.js';

/** Plex recommends a timeline heartbeat every ten seconds on LAN and WAN connections. */
export const PLEX_REPORT_INTERVAL_MS = 10_000;

/** Reporting has a short deadline independent of tune readiness and upstream media reads. */
export const PLEX_REPORT_TIMEOUT_MS = 3_000;

/** Item-relative position and identity for one Plex airing, independent of its physical parts. */
export interface PlexPlaybackReport {
	ratingKey: string;
	sessionId: string;
	positionMilliseconds: number;
	durationMilliseconds: number;
}

/**
 * Report each channel as a separate Plex player without advertising remote controls.
 * The session follows the airing rather than upstream reads. Plex may update the connected
 * account's resume position and watch history from these authenticated reports.
 */
export class PlexPlaybackClient {
	private readonly headers: Record<string, string>;

	constructor(
		private readonly fetch: MediaFetch,
		private readonly connection: MediaServerConnection,
		channel: { id: string; number: string; name: string },
	) {
		const clientIdentifier = createHash('sha256')
			.update(connection.clientIdentifier).update('\0').update(channel.id).digest('hex');
		const device = `Moirai · ${channel.number} ${channel.name}`.replace(/\p{Cc}/gu, ' ').slice(0, 120).trim();
		this.headers = {
			...plexAuthHeaders({ ...connection, clientIdentifier }),
			'X-Plex-Device': 'Moirai channel',
			// Plex accepts UTF-8 header bytes; fetch represents those bytes as a Latin-1 string.
			'X-Plex-Device-Name': Buffer.from(device, 'utf8').toString('latin1'),
		};
	}

	/** Send one bounded timeline report and discard its body without exposing provider errors. */
	async report(event: 'start' | 'progress' | 'stop', report: PlexPlaybackReport, signal?: AbortSignal): Promise<void> {
		const query = new URLSearchParams({
			identifier: 'com.plexapp.plugins.library',
			key: `/library/metadata/${report.ratingKey}`,
			ratingKey: report.ratingKey,
			state: event === 'stop' ? 'stopped' : 'playing',
			time: String(Math.min(report.durationMilliseconds, Math.max(0, report.positionMilliseconds))),
			duration: String(report.durationMilliseconds),
		});
		const deadline = AbortSignal.timeout(PLEX_REPORT_TIMEOUT_MS);
		const response = await this.fetch(mediaServerUrl(this.connection.baseUrl, `/:/timeline?${query}`), {
			method: 'POST',
			headers: { ...this.headers, 'X-Plex-Session-Identifier': report.sessionId },
			signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
		});
		await response.body?.cancel();
		if (!response.ok) {
			throw new MediaServerRequestError(`Plex playback report returned HTTP ${response.status}`, response.status);
		}
	}
}
