import type { MediaServerConnection } from './items.js';
import type { MediaFetch } from './http.js';
import { JellyfinClient } from './jellyfin-client.js';
import { PlexClient } from './plex-client.js';

/** Provider client that can inspect, list, and stream one saved server. */
export type MediaServerClient = PlexClient | JellyfinClient;

/** Open the client that matches a saved server's provider. */
export function openMediaServerClient(
	fetch: MediaFetch,
	connection: MediaServerConnection,
): MediaServerClient {
	return connection.provider === 'plex'
		? new PlexClient(fetch, connection)
		: new JellyfinClient(fetch, connection);
}
