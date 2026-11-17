import type { MediaServerConnection } from './items.js';
import { validatedMediaClientIdentifier, validatedMediaToken } from './credentials.js';

/** Plex product headers that identify Moirai without copying another application's client id. */
export const PLEX_PRODUCT = {
	'X-Plex-Product': 'Moirai',
	'X-Plex-Version': '1',
	'X-Plex-Platform': 'Moirai',
	Accept: 'application/json',
};

/** Authenticate Plex requests without putting credentials in URLs. */
export function plexAuthHeaders(connection: MediaServerConnection): Record<string, string> {
	return {
		...PLEX_PRODUCT,
		'X-Plex-Client-Identifier': validatedMediaClientIdentifier(connection.clientIdentifier),
		'X-Plex-Token': validatedMediaToken(connection.accessToken),
	};
}
