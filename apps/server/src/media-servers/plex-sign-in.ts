import { z } from 'zod';
import type { MediaFetch } from './http.js';
import { MediaServerRequestError, normalizeBaseUrl, readJson } from './http.js';
import { PLEX_PRODUCT } from './plex-auth.js';
import { validatedMediaClientIdentifier, validatedMediaToken } from './credentials.js';

/** Resource discovery can include players and servers without an available credential. */
const plexResourcesSchema = z.array(z.object({
	provides: z.string().nullish(),
	accessToken: z.unknown().optional(),
	connections: z.array(z.object({ uri: z.string() })).nullish(),
}));

/** Compare canonical Plex-advertised addresses without accepting credentials or malformed URLs. */
function sameAddress(candidate: string, destination: string): boolean {
	try {
		return normalizeBaseUrl(candidate) === destination;
	}
	catch {
		return false;
	}
}

/**
 * Exchange an account token only with Plex, returning the selected server's resource credential.
 * The destination must match one advertised resource connection exactly; identity claims from an
 * arbitrary server cannot authorize disclosure. Unadvertised reverse proxies require a manual token.
 */
export async function plexServerToken(
	fetch: MediaFetch,
	clientIdentifier: string,
	accountToken: string,
	baseUrl: string,
): Promise<string> {
	const destination = normalizeBaseUrl(baseUrl);
	const response = await fetch('https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1', {
		headers: {
			...PLEX_PRODUCT,
			'X-Plex-Client-Identifier': validatedMediaClientIdentifier(clientIdentifier),
			'X-Plex-Token': validatedMediaToken(accountToken),
		},
	});
	const parsed = plexResourcesSchema.safeParse(await readJson<unknown>(response, 'Plex'));
	if (!parsed.success) {
		throw new MediaServerRequestError('Plex returned a server list Moirai could not read');
	}

	const matches = parsed.data.filter(resource => resource.provides?.split(',').some(value => value.trim() === 'server')
		&& resource.connections?.some(connection => sameAddress(connection.uri, destination)));
	if (matches.length !== 1) {
		throw new MediaServerRequestError('Use a server address advertised by your Plex account, or enter a server token manually');
	}
	if (!matches[0]!.accessToken) {
		throw new MediaServerRequestError('Plex did not return a credential for this server');
	}

	return validatedMediaToken(matches[0]!.accessToken);
}
