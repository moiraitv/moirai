import type { MediaServerConnection } from './items.js';
import { validatedMediaClientIdentifier, validatedMediaToken } from './credentials.js';

/** Authorization headers for Jellyfin or Emby. A null token is the sign-in request. */
export function jellyfinAuthHeaders(
	connection: Pick<MediaServerConnection, 'provider' | 'clientIdentifier'>,
	token: string | null,
	device = 'Moirai',
): Record<string, string> {
	const clientIdentifier = validatedMediaClientIdentifier(connection.clientIdentifier);
	const credential = token === null ? null : validatedMediaToken(token);
	const authorization = `MediaBrowser Client="Moirai", Device="${device}", DeviceId="${clientIdentifier}", Version="1"${credential ? `, Token="${credential}"` : ''}`;
	return {
		Accept: 'application/json',
		Authorization: authorization,
		...(connection.provider === 'emby' && credential ? { 'X-Emby-Token': credential } : {}),
	};
}

