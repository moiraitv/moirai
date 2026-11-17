import { z } from 'zod';

/** Identifier contract shared with the rest of the API. */
const idSchema = z.uuid();

/** Providers that can index and play a remote media library. */
export const MEDIA_SERVER_PROVIDERS = ['plex', 'jellyfin', 'emby'] as const;
/** One supported remote media-server provider. */
export const mediaServerProviderSchema = z.enum(MEDIA_SERVER_PROVIDERS);
/** Supported remote media-server provider. */
export type MediaServerProvider = z.infer<typeof mediaServerProviderSchema>;

/** Providers with an optional, implemented playback-reporting lifecycle. */
export const MEDIA_SERVER_PLAYBACK_REPORTING_PROVIDERS = ['plex', 'jellyfin'] as const;

/** Playback scheme stored when a part is streamed from a media server. */
export const REMOTE_PLAYBACK_SCHEME = 'moirai-remote:';

/** Maximum folder mappings retained by one shared media-server connection. */
export const MAX_MEDIA_SERVER_PATH_REPLACEMENTS = 32;

/** Ordered folder mapping from a media server path to a local file the channel worker can read. */
export const mediaServerPathReplacementSchema = z.object({
	remotePrefix: z.string().trim().min(1).max(1_000),
	localPrefix: z.string().trim().min(1).max(1_000),
});
/** One remote-to-local folder mapping. */
export type MediaServerPathReplacement = z.infer<typeof mediaServerPathReplacementSchema>;

/** Library selection stored for a Plex, Jellyfin, or Emby source. Credentials stay on the server. */
export const remoteLibrarySourceConfigSchema = z.object({
	mediaServerId: idSchema,
	remoteLibraryId: z.string().trim().min(1).max(200),
	remoteLibraryName: z.string().trim().min(1).max(200),
});
/** Source configuration for one remote library. */
export type RemoteLibrarySourceConfig = z.infer<typeof remoteLibrarySourceConfigSchema>;

/** Header-safe opaque token; whitespace, quotes, and escapes are not credential characters. */
export const mediaServerTokenSchema = z.string().trim().min(1).max(4_000)
	.regex(/^[\x21-\x7e]+$/, 'Credential must contain printable ASCII characters without spaces')
	.refine((value) => !/["\\]/.test(value), 'Credential cannot contain quotes or backslashes');

/** Header-safe client identity shared by saved connections and sign-in exchanges. */
export const mediaServerClientIdentifierSchema = z.string().trim().min(8).max(80)
	.regex(/^[\x21-\x7e]+$/, 'Client identifier must contain printable ASCII characters without spaces')
	.refine((value) => !/["\\]/.test(value), 'Client identifier cannot contain quotes or backslashes');

/** Bind a Plex PIN poll to the server address that may receive its resource credential. */
export const plexPinPollSchema = z.object({
	clientIdentifier: mediaServerClientIdentifierSchema,
	baseUrl: z.string().trim().url().max(500),
});
/** Destination-bound Plex link-code polling request. */
export type PlexPinPoll = z.infer<typeof plexPinPollSchema>;

/** Connection fields shared by create, update, and a credential probe. */
const mediaServerConnectionSchema = z.object({
	provider: mediaServerProviderSchema,
	name: z.string().trim().min(1).max(120),
	baseUrl: z.string().trim().url().max(500),
	allowInsecureTls: z.boolean().default(false),
	playbackReportingEnabled: z.boolean().default(false),
	pathReplacements: z.array(mediaServerPathReplacementSchema).max(MAX_MEDIA_SERVER_PATH_REPLACEMENTS).default([]),
});

/** Validate a new media server, including the write-only credential. */
export const mediaServerCreateSchema = mediaServerConnectionSchema.extend({
	accessToken: mediaServerTokenSchema,
	clientIdentifier: mediaServerClientIdentifierSchema.optional(),
});
/** Fields required to save a media server. */
export type MediaServerCreate = z.infer<typeof mediaServerCreateSchema>;

/**
 * Validate edits. A blank credential keeps the stored token.
 * Omitted fields stay omitted. Defaults from the create schema must not fill a partial update,
 * or a name-only change would clear folder mappings and turn off insecure TLS.
 */
export const mediaServerUpdateSchema = z.object({
	provider: mediaServerProviderSchema.optional(),
	name: z.string().trim().min(1).max(120).optional(),
	baseUrl: z.string().trim().url().max(500).optional(),
	allowInsecureTls: z.boolean().optional(),
	playbackReportingEnabled: z.boolean().optional(),
	pathReplacements: z.array(mediaServerPathReplacementSchema).max(MAX_MEDIA_SERVER_PATH_REPLACEMENTS).optional(),
	accessToken: z.string().trim().pipe(z.union([z.literal(''), mediaServerTokenSchema])).optional(),
	clientIdentifier: mediaServerClientIdentifierSchema.optional(),
});
/** Editable media-server fields. */
export type MediaServerUpdate = z.infer<typeof mediaServerUpdateSchema>;

/** Validate a connection test that does not save the server. */
export const mediaServerProbeSchema = z.object({
	provider: mediaServerProviderSchema,
	baseUrl: z.string().trim().url().max(500),
	accessToken: mediaServerTokenSchema,
	allowInsecureTls: z.boolean().default(false),
	clientIdentifier: mediaServerClientIdentifierSchema.optional(),
	typeKey: z.string().trim().min(1).max(64).default('movies'),
});
/** Test edited connection fields while retaining a saved credential only at its trusted destination. */
export const savedMediaServerProbeSchema = mediaServerUpdateSchema.pick({
	provider: true,
	baseUrl: true,
	accessToken: true,
	allowInsecureTls: true,
	clientIdentifier: true,
}).extend({ typeKey: z.enum(['movies', 'shows', 'music-videos', 'other']).default('movies') });
/** Non-persisting connection test for a saved server. */
export type SavedMediaServerProbe = z.infer<typeof savedMediaServerProbeSchema>;

/** Unsaved connection used to list remote libraries. */
export type MediaServerProbe = z.infer<typeof mediaServerProbeSchema>;

/** Validate a Jellyfin or Emby username exchange. The password is not stored. */
export const mediaServerSignInSchema = z.object({
	provider: z.enum(['jellyfin', 'emby']),
	baseUrl: z.string().trim().url().max(500),
	username: z.string().trim().min(1).max(200),
	password: z.string().min(1).max(1_000),
	allowInsecureTls: z.boolean().default(false),
	clientIdentifier: mediaServerClientIdentifierSchema.optional(),
});
/** One-time sign-in used to obtain an API token. */
export type MediaServerSignIn = z.infer<typeof mediaServerSignInSchema>;

/** Public media server returned to the browser. The access token is never included. */
export interface MediaServer {
	id: string;
	provider: MediaServerProvider;
	name: string;
	baseUrl: string;
	serverKey: string;
	serverName: string;
	clientIdentifier: string;
	allowInsecureTls: boolean;
	playbackReportingEnabled: boolean;
	pathReplacements: MediaServerPathReplacement[];
	hasCredential: boolean;
	credentialPlaceholder: string | null;
	createdAt: string;
	updatedAt: string;
}

/** Remote library the operator can attach to a Moirai library. */
export interface RemoteLibraryChoice {
	id: string;
	name: string;
	typeKey: 'movies' | 'shows' | 'music-videos' | 'other';
}

/** Encode a provider part so playout can mint a loopback stream URL without a credential. */
export function remotePlaybackReference(mediaServerId: string, partId: string): string {
	return `${REMOTE_PLAYBACK_SCHEME}${mediaServerId}/${encodeURIComponent(partId)}`;
}

/** Decode a stored remote playback reference. Local filesystem paths return null. */
export function parseRemotePlaybackReference(value: string): { mediaServerId: string; partId: string } | null {
	if (!value.startsWith(REMOTE_PLAYBACK_SCHEME)) {
		return null;
	}

	const rest = value.slice(REMOTE_PLAYBACK_SCHEME.length);
	const slash = rest.indexOf('/');
	if (slash <= 0 || slash === rest.length - 1) {
		return null;
	}

	try {
		const partId = decodeURIComponent(rest.slice(slash + 1));
		return partId ? { mediaServerId: rest.slice(0, slash), partId } : null;
	}
	catch {
		return null;
	}
}
