import type { MediaFetch } from './http.js';
import { remoteMetadataText } from './metadata.js';
import { MediaServerRequestError, mediaServerUrl, readJson } from './http.js';
import { validatedMediaToken } from './credentials.js';
import { jellyfinAuthHeaders } from './jellyfin-auth.js';
import { MediaListingBudget } from './listing-budget.js';
import type {
	MediaServerConnection,
	MediaServerInspection,
	RemoteLibraryListing,
	RemoteLibraryType,
	RemoteMediaItem,
	RemotePart,
	RemoteStream,
} from './items.js';

/** Page size for Jellyfin and Emby item queries. */
const PAGE_SIZE = 200;

/**
 * Talk to Jellyfin or Emby. The two servers share item and library shapes; authentication
 * headers differ. Passwords are exchanged for a token and are not retained by this client.
 */
export class JellyfinClient {
	constructor(
		private readonly fetch: MediaFetch,
		private readonly connection: MediaServerConnection,
	) {}

	/** Exchange a username and password for an access token. The password is not returned. */
	static async signIn(
		fetch: MediaFetch,
		connection: Pick<MediaServerConnection, 'provider' | 'baseUrl' | 'clientIdentifier'>,
		username: string,
		password: string,
	): Promise<string> {
		const response = await fetch(mediaServerUrl(connection.baseUrl, '/Users/AuthenticateByName'), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...jellyfinAuthHeaders(connection, null),
			},
			body: JSON.stringify({ Username: username, Pw: password }),
		});
		const body = await readJson<{ AccessToken?: string }>(response, serverLabel(connection.provider));
		const token = body.AccessToken;
		if (!token) {
			throw new MediaServerRequestError(`${serverLabel(connection.provider)} did not return an access token`);
		}

		return validatedMediaToken(token);
	}

	/** Confirm the token and list libraries Moirai can index. */
	async inspect(): Promise<MediaServerInspection> {
		const label = serverLabel(this.connection.provider);
		const info = await this.getJson<{ Id?: string; ServerId?: string; ServerName?: string }>('/System/Info');
		const serverKey = (info.Id ?? info.ServerId)?.trim();
		if (!serverKey) {
			throw new MediaServerRequestError(`${label} did not identify this server`);
		}

		// Root items honor the signed-in user's library access and also accept server API keys.
		const folders = await this.getJson<{ Items?: JellyfinFolder[] }>(this.connection.provider === 'jellyfin'
			? '/Items?Recursive=false&IncludeItemTypes=CollectionFolder'
			: '/Library/MediaFolders');
		return {
			serverKey,
			serverName: info.ServerName?.trim() || label,
			libraries: (folders.Items ?? []).flatMap(projectLibrary),
		};
	}

	/**
	 * Page one library into normalized playable items.
	 * An empty library and a short page with no total are complete. An empty page before a
	 * reported total, or a total smaller than the rows read, fails the scan so removals stay unconfirmed.
	 */
	async listItems(remoteLibraryId: string, typeKey: RemoteLibraryType, signal?: AbortSignal): Promise<RemoteMediaItem[]> {
		const itemType = typeKey === 'movies'
			? 'Movie'
			: typeKey === 'shows'
				? 'Episode'
				: typeKey === 'music-videos'
					? 'MusicVideo'
					: 'Video';
		const fields = [
			'Path', 'Genres', 'Overview', 'ProviderIds', 'MediaSources', 'MediaStreams',
			'DateCreated', 'PremiereDate', 'ProductionYear', 'People', 'Chapters',
			'SeriesId', 'SeriesName', 'ParentIndexNumber', 'IndexNumber',
			'Album', 'AlbumId', 'Artists', 'ImageTags', 'BackdropImageTags', 'SeriesPrimaryImageTag',
			'SortName', 'DateLastSaved', 'OriginalTitle', 'Studios', 'ProductionLocations', 'Tags',
		].join(',');
		const items: JellyfinItem[] = [];
		let start = 0;
		const budget = new MediaListingBudget();
		for (;;) {
			budget.nextPage();
			const body = await this.getJson<{ Items?: JellyfinItem[]; TotalRecordCount?: number }>(
				`/Items?ParentId=${encodeURIComponent(remoteLibraryId)}&Recursive=true&IncludeItemTypes=${itemType}&Fields=${encodeURIComponent(fields)}&StartIndex=${start}&Limit=${PAGE_SIZE}`,
				signal,
				(bytes) => budget.consumeBytes(bytes),
			);
			const page = body.Items ?? [];

			const total = body.TotalRecordCount;
			budget.acceptPage(page.map((row) => row.Id), total);
			const label = serverLabel(this.connection.provider);
			if (page.length === 0) {
				if (total === undefined || total === items.length) {
					break;
				}

				throw new MediaServerRequestError(`${label} ended this library listing before reporting every item`);
			}

			items.push(...page);
			start += page.length;
			if (total === undefined) {
				if (page.length < PAGE_SIZE) {
					break;
				}

				throw new MediaServerRequestError(`${label} did not report how many items are in this library`);
			}

			if (total < start) {
				throw new MediaServerRequestError(`${label} reported fewer items than this listing returned`);
			}

			if (start >= total) {
				break;
			}
		}

		return items.flatMap((item) => projectItem(item, typeKey));
	}

	/** Report whether an item id still exists. */
	async itemExists(itemId: string, signal?: AbortSignal): Promise<boolean> {
		const response = await this.fetch(this.url(`/Items?Ids=${encodeURIComponent(itemId)}&Limit=1`), {
			headers: jellyfinAuthHeaders(this.connection, this.connection.accessToken),
			signal,
		});
		if (response.status === 404) {
			await response.body?.cancel();
			return false;
		}

		const body = await readJson<{ Items?: unknown[] }>(response, serverLabel(this.connection.provider));
		return (body.Items ?? []).length > 0;
	}

	/** Direct static stream for one item and media source. */
	streamRequest(partId: string): { url: string; headers: Record<string, string> } {
		const separator = partId.indexOf(':');
		const itemId = separator === -1 ? partId : partId.slice(0, separator);
		const mediaSourceId = separator === -1 ? '' : partId.slice(separator + 1);
		const source = mediaSourceId ? `&MediaSourceId=${encodeURIComponent(mediaSourceId)}` : '';
		return {
			url: this.url(`/Videos/${encodeURIComponent(itemId ?? partId)}/stream?static=true${source}`),
			headers: jellyfinAuthHeaders(this.connection, this.connection.accessToken),
		};
	}

	/** Authenticated image request. */
	artworkRequest(imagePath: string): { url: string; headers: Record<string, string> } {
		return {
			url: this.url(imagePath),
			headers: jellyfinAuthHeaders(this.connection, this.connection.accessToken),
		};
	}

	/** GET one JSON resource. */
	private async getJson<T>(pathname: string, signal?: AbortSignal, onBytes?: (bytes: number) => void): Promise<T> {
		const response = await this.fetch(this.url(pathname), {
			headers: jellyfinAuthHeaders(this.connection, this.connection.accessToken),
			signal,
		});
		return readJson<T>(response, serverLabel(this.connection.provider), onBytes);
	}

	/** Join a root-relative path to the server address. */
	private url(pathname: string): string {
		return mediaServerUrl(this.connection.baseUrl, pathname);
	}
}

/** Jellyfin or Emby library folder. */
interface JellyfinFolder {
	Id?: string;
	Name?: string;
	CollectionType?: string;
}

/** Jellyfin or Emby item row. */
interface JellyfinItem {
	Id?: string;
	Name?: string;
	Type?: string;
	Path?: string;
	Overview?: string;
	SortName?: string;
	OriginalTitle?: string;
	CommunityRating?: number;
	UserData?: { Rating?: number };
	OfficialRating?: string;
	Studios?: Array<{ Name?: string }>;
	ProductionLocations?: string[];
	Tags?: string[];
	MediaStreams?: JellyfinStream[];
	ProductionYear?: number;
	PremiereDate?: string;
	RunTimeTicks?: number;
	DateCreated?: string;
	DateLastSaved?: string;
	SeriesId?: string;
	SeriesName?: string;
	ParentIndexNumber?: number;
	IndexNumber?: number;
	Album?: string;
	AlbumId?: string;
	Artists?: string[];
	Genres?: string[];
	ProviderIds?: Record<string, string>;
	People?: Array<{ Name?: string; Type?: string; Role?: string }>;
	ImageTags?: { Primary?: string; Thumb?: string };
	BackdropImageTags?: string[];
	SeriesPrimaryImageTag?: string;
	MediaSources?: JellyfinSource[];
	Chapters?: Array<{ Name?: string; StartPositionTicks?: number }>;
}

/** One Jellyfin media source and its streams. */
interface JellyfinSource {
	Id?: string;
	Path?: string;
	Size?: number;
	Container?: string;
	RunTimeTicks?: number;
	MediaStreams?: JellyfinStream[];
}

/** One Jellyfin elementary stream. */
interface JellyfinStream {
	Index?: number;
	Type?: string;
	Codec?: string;
	Language?: string;
	Title?: string;
	Channels?: number;
	Width?: number;
	Height?: number;
	IsDefault?: boolean;
	IsForced?: boolean;
	IsHearingImpaired?: boolean;
	IsInterlaced?: boolean;
	IsExternal?: boolean;
	DeliveryMethod?: string;
}

/** Display name used in safe errors. */
function serverLabel(provider: MediaServerConnection['provider']): string {
	return provider === 'emby' ? 'Emby' : 'Jellyfin';
}

/** Map a media folder onto a Moirai library type. Collections and music are skipped. */
function projectLibrary(folder: JellyfinFolder): RemoteLibraryListing[] {
	if (!folder.Id || !folder.Name) {
		return [];
	}

	const collection = folder.CollectionType?.toLowerCase();
	const typeKey: RemoteLibraryType | null = collection === 'movies'
		? 'movies'
		: collection === 'tvshows'
			? 'shows'
			: collection === 'musicvideos'
				? 'music-videos'
				: collection === 'homevideos' || collection === 'mixed'
					? 'other'
					: null;
	return typeKey ? [{ id: folder.Id, name: folder.Name, typeKey }] : [];
}

/** Map one Jellyfin item, skipping stream-link placeholders. */
function projectItem(item: JellyfinItem, typeKey: RemoteLibraryType): RemoteMediaItem[] {
	if (!item.Id || !item.Name) {
		return [];
	}

	const path = item.Path ?? item.MediaSources?.[0]?.Path ?? '';
	if (path.toLowerCase().endsWith('.strm')) {
		return [];
	}

	// MediaSources are alternate versions, not consecutive files of one item.
	const source = item.MediaSources?.[0] ?? { Id: item.Id, ...(item.Path ? { Path: item.Path } : {}) };
	const ticks = source.RunTimeTicks ?? item.RunTimeTicks ?? null;
	const duration = ticks === null ? null : Math.round(ticks / 10_000);
	const chapters = chaptersFrom(item, duration);
	const parts = projectPart(item.Id, { ...source, Path: source.Path ?? item.Path ?? '', MediaStreams: source.MediaStreams ?? item.MediaStreams ?? [] }, chapters, duration);
	if (parts.length === 0) {
		return [];
	}

	const kind = typeKey === 'shows' ? 'episode' : typeKey === 'music-videos' ? 'music-video' : typeKey === 'other' ? 'other' : 'movie';
	return [{
		id: item.Id,
		etag: item.DateLastSaved ?? item.DateCreated ?? item.Id,
		kind,
		title: item.Name,
		sortTitle: remoteMetadataText(item.SortName),
		plot: item.Overview ?? null,
		year: typeof item.ProductionYear === 'number' ? item.ProductionYear : null,
		show: kind === 'episode' && item.SeriesId ? {
			id: item.SeriesId,
			title: item.SeriesName || 'Show',
			year: null,
			plot: null,
			posterPath: item.SeriesPrimaryImageTag ? `/Items/${item.SeriesId}/Images/Primary?tag=${encodeURIComponent(item.SeriesPrimaryImageTag)}` : null,
			fanartPath: null,
		} : null,
		seasonNumber: kind === 'episode' && typeof item.ParentIndexNumber === 'number' ? item.ParentIndexNumber : null,
		seasonTitle: null,
		episodeNumber: kind === 'episode' && typeof item.IndexNumber === 'number' ? item.IndexNumber : null,
		artists: (item.Artists ?? []).filter((artist) => artist.trim()),
		album: item.Album ?? null,
		albumId: item.AlbumId ?? null,
		trackNumber: kind === 'music-video' && typeof item.IndexNumber === 'number' ? item.IndexNumber : null,
		genres: item.Genres ?? [],
		directors: (item.People ?? []).flatMap((person) => person.Type === 'Director' && person.Name ? [person.Name] : []),
		actors: (item.People ?? []).flatMap((person, index) => person.Type === 'Actor' && person.Name ? [{
			name: person.Name,
			role: person.Role ?? null,
			sortOrder: index,
		}] : []),
		externalIds: projectProviders(item.ProviderIds),
		parts,
		posterPath: item.ImageTags?.Primary ? `/Items/${item.Id}/Images/Primary?tag=${encodeURIComponent(item.ImageTags.Primary)}` : null,
		landscapePath: item.ImageTags?.Thumb ? `/Items/${item.Id}/Images/Thumb?tag=${encodeURIComponent(item.ImageTags.Thumb)}` : null,
		fanartPath: item.BackdropImageTags?.[0] ? `/Items/${item.Id}/Images/Backdrop/0?tag=${encodeURIComponent(item.BackdropImageTags[0])}` : null,
		modifiedAt: item.DateLastSaved ?? item.DateCreated ?? new Date(0).toISOString(),
		metadata: {
			originalTitle: item.OriginalTitle ?? null,
			releaseDate: item.PremiereDate ?? null,
			rating: item.CommunityRating ?? null,
			userRating: item.UserData?.Rating ?? null,
			certification: item.OfficialRating ?? null,
			writers: (item.People ?? []).flatMap(person => person.Type === 'Writer' && person.Name ? [person.Name] : []),
			studios: (item.Studios ?? []).flatMap(studio => studio.Name ? [studio.Name] : []),
			countries: item.ProductionLocations ?? [],
			tags: item.Tags ?? [],
		},
	}];
}

/** Convert Jellyfin ticks into chapter ranges that end at the next chapter or the duration. */
function chaptersFrom(
	item: JellyfinItem,
	durationMilliseconds: number | null,
): RemotePart['chapters'] {
	const chapters = item.Chapters ?? [];
	return chapters.flatMap((chapter, index) => {
		if (typeof chapter.StartPositionTicks !== 'number') {
			return [];
		}

		const startSeconds = chapter.StartPositionTicks / 10_000_000;
		const next = chapters[index + 1]?.StartPositionTicks;
		const finishSeconds = typeof next === 'number'
			? next / 10_000_000
			: durationMilliseconds === null ? startSeconds : durationMilliseconds / 1_000;
		return [{ startSeconds, finishSeconds, title: chapter.Name ?? '' }];
	});
}

/** Map provider ids onto the catalog's imdb, tmdb, and tvdb keys. */
function projectProviders(ids: Record<string, string> | undefined): Array<{ provider: string; value: string }> {
	if (!ids) {
		return [];
	}

	const pairs: Array<[string, string | undefined]> = [
		['imdb', ids.Imdb ?? ids.imdb],
		['tmdb', ids.Tmdb ?? ids.tmdb],
		['tvdb', ids.Tvdb ?? ids.tvdb],
	];
	return pairs.flatMap(([provider, value]) => value ? [{ provider, value }] : []);
}

/** Map one media source onto a remote part. */
function projectPart(
	itemId: string,
	source: JellyfinSource,
	chapters: RemotePart['chapters'],
	fallbackDuration: number | null,
): RemotePart[] {
	const sourceId = source.Id ?? itemId;
	const ticks = source.RunTimeTicks;
	const durationMilliseconds = typeof ticks === 'number' ? Math.round(ticks / 10_000) : fallbackDuration;
	return [{
		id: `${itemId}:${sourceId}`,
		filePath: source.Path || null,
		durationMilliseconds,
		sizeBytes: typeof source.Size === 'number' ? source.Size : null,
		container: source.Container ?? null,
		streams: (source.MediaStreams ?? []).flatMap(projectStream),
		chapters,
	}];
}

/** Map a Jellyfin stream type string onto the catalog stream kinds. */
function projectStream(stream: JellyfinStream): RemoteStream[] {
	const type = stream.Type === 'Video' ? 'video' : stream.Type === 'Audio' ? 'audio' : stream.Type === 'Subtitle' ? 'subtitle' : null;
	if (!type || stream.Index === undefined) {
		return [];
	}

	if (stream.IsExternal === true || stream.DeliveryMethod?.toLowerCase() === 'external') {
		return [];
	}

	return [{
		index: stream.Index,
		type,
		codec: stream.Codec ?? null,
		language: stream.Language ?? null,
		title: stream.Title ?? null,
		channels: stream.Channels ?? null,
		width: stream.Width ?? null,
		height: stream.Height ?? null,
		isDefault: Boolean(stream.IsDefault),
		isForced: Boolean(stream.IsForced),
		isHearingImpaired: Boolean(stream.IsHearingImpaired),
		isCommentary: false,
		isAttachedPicture: false,
	}];
}
