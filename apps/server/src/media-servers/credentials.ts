import { mediaServerClientIdentifierSchema, mediaServerTokenSchema, type MediaServerUpdate } from '@moirai/shared';
import { MediaServerRequestError, normalizeBaseUrl } from './http.js';
import type { MediaServerConnection } from './items.js';

/** Validate saved and provider-issued tokens without retaining invalid values in an error. */
export function validatedMediaToken(value: unknown): string {
	const result = mediaServerTokenSchema.safeParse(value);
	if (!result.success) {
		throw new MediaServerRequestError('Media server credential contains invalid characters');
	}

	return result.data;
}

/** Validate a client identity before interpolating it into provider headers. */
export function validatedMediaClientIdentifier(value: unknown): string {
	const result = mediaServerClientIdentifierSchema.safeParse(value);
	if (!result.success) {
		throw new MediaServerRequestError('Media server client identifier contains invalid characters');
	}

	return result.data;
}

/**
 * Permit a stored credential only at its current canonical destination without weakening TLS.
 * Both preflight probes and serialized writes enforce this boundary; invalid legacy addresses
 * require an explicitly supplied credential before repair.
 */
export function canRetainMediaServerCredential(
	existing: Pick<MediaServerConnection, 'baseUrl' | 'allowInsecureTls'>,
	input: Pick<MediaServerUpdate, 'baseUrl' | 'allowInsecureTls'>,
): boolean {
	try {
		return normalizeBaseUrl(input.baseUrl ?? existing.baseUrl) === normalizeBaseUrl(existing.baseUrl)
			&& !(input.allowInsecureTls === true && !existing.allowInsecureTls);
	}
	catch {
		return false;
	}
}
