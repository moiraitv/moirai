/** Moirai library types a remote folder can fill. */
export type RemoteLibraryType = 'movies' | 'shows' | 'music-videos' | 'other';

/** One remote library the operator can attach. */
export interface RemoteLibraryListing {
	id: string;
	name: string;
	typeKey: RemoteLibraryType;
}

/** Provider stream reduced to the catalog's technical metadata shape. */
export interface RemoteStream {
	index: number;
	type: 'video' | 'audio' | 'subtitle';
	codec: string | null;
	language: string | null;
	title: string | null;
	channels: number | null;
	width: number | null;
	height: number | null;
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired: boolean;
	isCommentary: boolean;
	isAttachedPicture: boolean;
}

/** One physical file belonging to a remote item. */
export interface RemotePart {
	id: string;
	filePath: string | null;
	durationMilliseconds: number | null;
	sizeBytes: number | null;
	container: string | null;
	streams: RemoteStream[];
	chapters: Array<{ startSeconds: number; finishSeconds: number; title: string }>;
}

/** Show, season, artist, or album context carried on a playable item. */
export interface RemoteParent {
	id: string;
	title: string;
	year: number | null;
	plot: string | null;
	posterPath: string | null;
	fanartPath: string | null;
}

/** Optional provider facts used by shared filters and presentation without extra item requests. */
export interface RemoteDescriptiveMetadata {
	edition?: string | null;
	originalTitle?: string | null;
	releaseDate?: string | null;
	rating?: number | null;
	userRating?: number | null;
	certification?: string | null;
	writers?: string[];
	studios?: string[];
	countries?: string[];
	tags?: string[];
}

/** Normalized item produced by a Plex, Jellyfin, or Emby client. */
export interface RemoteMediaItem {
	id: string;
	etag: string;
	kind: 'movie' | 'episode' | 'music-video' | 'other';
	title: string;
	sortTitle: string | null;
	plot: string | null;
	year: number | null;
	show: RemoteParent | null;
	seasonNumber: number | null;
	seasonTitle: string | null;
	episodeNumber: number | null;
	artists: string[];
	album: string | null;
	albumId: string | null;
	trackNumber: number | null;
	genres: string[];
	directors: string[];
	actors: Array<{ name: string; role: string | null; sortOrder: number | null }>;
	externalIds: Array<{ provider: string; value: string }>;
	parts: RemotePart[];
	posterPath: string | null;
	landscapePath: string | null;
	fanartPath: string | null;
	modifiedAt: string;
	metadata?: RemoteDescriptiveMetadata;
}

/** Connection facts a client needs and a probe returns. */
export interface MediaServerConnection {
	provider: 'plex' | 'jellyfin' | 'emby';
	baseUrl: string;
	accessToken: string;
	clientIdentifier: string;
	allowInsecureTls: boolean;
}

/** Identity and libraries learned from one successful connection. */
export interface MediaServerInspection {
	serverKey: string;
	serverName: string;
	libraries: RemoteLibraryListing[];
}
