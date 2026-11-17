import type { MediaFetch } from './http.js';
import { MediaServerRequestError, mediaServerUrl, readJson } from './http.js';
import { validatedMediaClientIdentifier, validatedMediaToken } from './credentials.js';
import { PLEX_PRODUCT, plexAuthHeaders } from './plex-auth.js';
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

/** Page size for library section listings. */
const PAGE_SIZE = 200;

/** Agents whose movie libraries are personal videos rather than movies. */
const PERSONAL_MEDIA_AGENTS = new Set(['com.plexapp.agents.none', 'tv.plex.agents.none']);

/**
 * Talk to one Plex Media Server and to plex.tv for the link-code sign-in.
 * Callers supply the HTTP implementation so tests can replay recorded responses.
 */
export class PlexClient {
	constructor(
		private readonly fetch: MediaFetch,
		private readonly connection: MediaServerConnection,
	) {}

	/** Request a short PIN for manual entry at plex.tv/link using this server's client identifier. */
	static async createPin(fetch: MediaFetch, clientIdentifier: string): Promise<{ pinId: number; code: string }> {
		const response = await fetch('https://plex.tv/api/v2/pins', {
			method: 'POST',
			headers: { ...PLEX_PRODUCT, 'X-Plex-Client-Identifier': validatedMediaClientIdentifier(clientIdentifier) },
		});
		const body = await readJson<{ id?: number; code?: string }>(response, 'Plex');
		if (!body.id || !body.code) {
			throw new MediaServerRequestError('Plex did not return a sign-in code');
		}

		return { pinId: body.id, code: body.code };
	}

	/** Read the Plex account token for resource discovery; never send this token to a draft server. */
	static async pollPin(
		fetch: MediaFetch,
		clientIdentifier: string,
		pinId: number,
	): Promise<string | null> {
		const response = await fetch(`https://plex.tv/api/v2/pins/${pinId}`, {
			headers: { ...PLEX_PRODUCT, 'X-Plex-Client-Identifier': validatedMediaClientIdentifier(clientIdentifier) },
		});
		const body = await readJson<{ authToken?: string }>(response, 'Plex');
		return body.authToken ? validatedMediaToken(body.authToken) : null;
	}

	/** Confirm the token and list movie, show, and other-video libraries. */
	async inspect(): Promise<MediaServerInspection> {
		const identity = await this.getJson<{
			MediaContainer?: { machineIdentifier?: string; friendlyName?: string };
		}>('/identity');
		const serverKey = identity.MediaContainer?.machineIdentifier?.trim();
		if (!serverKey) {
			throw new MediaServerRequestError('Plex did not identify this server');
		}

		const sections = await this.getJson<{
			MediaContainer?: { Directory?: PlexDirectory[] };
		}>('/library/sections');
		return {
			serverKey,
			serverName: identity.MediaContainer?.friendlyName?.trim() || 'Plex',
			libraries: (sections.MediaContainer?.Directory ?? []).flatMap(projectLibrary),
		};
	}

	/** Page one library section into normalized movies, episodes, or other videos. */
	async listItems(remoteLibraryId: string, typeKey: RemoteLibraryType, signal?: AbortSignal): Promise<RemoteMediaItem[]> {
		if (typeKey === 'music-videos') {
			return [];
		}

		const plexType = typeKey === 'shows' ? 4 : 1;
		const rows = await this.pages(`/library/sections/${encodeURIComponent(remoteLibraryId)}/all?type=${plexType}&includeGuids=1&includeChapters=1`, signal);
		return rows.flatMap((row) => projectItem(row, typeKey));
	}

	/** Report whether one rating key still exists. Network failures throw. */
	async itemExists(itemId: string, signal?: AbortSignal): Promise<boolean> {
		const response = await this.fetch(this.url(`/library/metadata/${encodeURIComponent(itemId)}`), {
			headers: this.headers(),
			signal,
		});
		await response.body?.cancel();
		if (response.status === 404) {
			return false;
		}

		if (!response.ok) {
			throw new MediaServerRequestError(`Plex returned HTTP ${response.status}`, response.status);
		}

		return true;
	}

	/** Upstream URL and headers for one Plex part. The token stays in the header. */
	streamRequest(partId: string): { url: string; headers: Record<string, string> } {
		return {
			url: this.url(`/library/parts/${encodeURIComponent(partId)}/file?download=1`),
			headers: this.headers(),
		};
	}

	/** Authenticated image request for a Plex thumb or art path. */
	artworkRequest(imagePath: string): { url: string; headers: Record<string, string> } {
		return { url: this.url(imagePath), headers: this.headers() };
	}

	/**
	 * Page a Plex listing until every metadata row has been read.
	 * An empty library and a short page with no total are complete. An empty page before a
	 * reported total, or a total smaller than the rows read, fails the scan so removals stay unconfirmed.
	 */
	private async pages(pathname: string, signal?: AbortSignal): Promise<PlexMetadata[]> {
		const items: PlexMetadata[] = [];
		let start = 0;
		const budget = new MediaListingBudget();
		for (;;) {
			budget.nextPage();
			const response = await this.fetch(this.url(pathname), {
				headers: {
					...this.headers(),
					'X-Plex-Container-Start': String(start),
					'X-Plex-Container-Size': String(PAGE_SIZE),
				},
				signal,
			});
			const headerTotal = numberedHeader(response.headers.get('x-plex-container-total-size'));
			const body = await readJson<{
				MediaContainer?: { size?: number; totalSize?: number; Metadata?: PlexMetadata[] };
			} | null>(response, 'Plex', (bytes) => budget.consumeBytes(bytes));
			const container = body?.MediaContainer;
			if (!container || typeof container !== 'object' || Array.isArray(container)) {
				throw new MediaServerRequestError('Plex did not return a library listing');
			}

			// Plex can omit Metadata on a page it explicitly marks empty.
			const declared = container.totalSize;
			const total = declared === undefined ? headerTotal : declared;
			const metadata = container.Metadata;
			const explicitlyEmpty = container.size === 0 || (container.size === undefined && total === 0);
			if (metadata === undefined ? !explicitlyEmpty : !Array.isArray(metadata)) {
				throw new MediaServerRequestError('Plex did not return a library listing');
			}
			const page = metadata ?? [];

			budget.acceptPage(page.map((row) => row?.ratingKey), total);
			if (page.length === 0) {
				if (total === undefined || total === items.length) {
					return items;
				}

				throw new MediaServerRequestError('Plex ended this library listing before reporting every item');
			}

			items.push(...page);
			start += page.length;
			if (total === undefined) {
				if (page.length < PAGE_SIZE) {
					return items;
				}

				throw new MediaServerRequestError('Plex did not report how many items are in this library');
			}

			if (total < start) {
				throw new MediaServerRequestError('Plex reported fewer items than this listing returned');
			}

			if (start >= total) {
				return items;
			}
		}
	}

	/** GET one JSON resource from the configured server. */
	private async getJson<T>(pathname: string, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<T> {
		const response = await this.fetch(this.url(pathname), {
			headers: { ...this.headers(), ...extraHeaders },
			signal,
		});
		return readJson<T>(response, 'Plex');
	}

	/** Build an absolute Plex URL from a root-relative path. */
	private url(pathname: string): string {
		return mediaServerUrl(this.connection.baseUrl, pathname);
	}

	/** Headers for an authenticated Plex request. */
	private headers(): Record<string, string> {
		return plexAuthHeaders(this.connection);
	}
}

/** Plex library directory entry. */
interface PlexDirectory {
	key?: string;
	title?: string;
	type?: string;
	agent?: string;
}

/** Plex metadata row used for movies and episodes. */
interface PlexMetadata {
	ratingKey?: string;
	title?: string;
	titleSort?: string;
	summary?: string;
	originalTitle?: string;
	editionTitle?: string;
	rating?: number;
	audienceRating?: number;
	userRating?: number;
	contentRating?: string;
	studio?: string;
	Writer?: Array<{ tag?: string }>;
	Country?: Array<{ tag?: string }>;
	Label?: Array<{ tag?: string }>;
	year?: number;
	originallyAvailableAt?: string;
	updatedAt?: number;
	addedAt?: number;
	index?: number;
	parentIndex?: number;
	parentTitle?: string;
	grandparentTitle?: string;
	grandparentRatingKey?: string;
	grandparentThumb?: string;
	grandparentArt?: string;
	thumb?: string;
	art?: string;
	Guid?: Array<{ id?: string }>;
	Genre?: Array<{ tag?: string }>;
	Role?: Array<{ tag?: string; role?: string }>;
	Director?: Array<{ tag?: string }>;
	Media?: PlexMedia[];
	Chapter?: Array<{ startTimeOffset?: number; endTimeOffset?: number; title?: string; tag?: string }>;
}

/** One quality version and the stacked files that make up that version. */
interface PlexMedia {
	duration?: number;
	bitrate?: number;
	width?: number;
	height?: number;
	Part?: PlexPart[];
}

/** A Plex version whose parts can all be addressed independently. */
type IdentifiedPlexMedia = PlexMedia & { Part: PlexPart[] };

/** One physical Plex part. */
interface PlexPart {
	id: number | string;
	file?: string;
	size?: number;
	container?: string;
	duration?: number;
	Stream?: PlexStream[];
}

/** One elementary stream inside a Plex part. */
interface PlexStream {
	index?: number;
	streamType?: number;
	codec?: string;
	language?: string;
	languageTag?: string;
	title?: string;
	channels?: number;
	width?: number;
	height?: number;
	key?: string;
	selected?: boolean;
	default?: boolean;
	forced?: boolean;
	hearingImpaired?: boolean;
	comment?: boolean;
	streamTypeName?: string;
}

/** Map a Plex section onto a Moirai library type, skipping photos and music. */
function projectLibrary(directory: PlexDirectory): RemoteLibraryListing[] {
	if (!directory.key || !directory.title) {
		return [];
	}

	if (directory.type === 'show') {
		return [{ id: directory.key, name: directory.title, typeKey: 'shows' }];
	}

	if (directory.type !== 'movie') {
		return [];
	}

	const personal = directory.agent ? PERSONAL_MEDIA_AGENTS.has(directory.agent) : false;
	return [{ id: directory.key, name: directory.title, typeKey: personal ? 'other' : 'movies' }];
}

/** Map one Plex metadata row onto a catalog item, dropping rows without a file. */
function projectItem(row: PlexMetadata, typeKey: RemoteLibraryType): RemoteMediaItem[] {
	if (!row.ratingKey || !row.title) {
		return [];
	}

	const media = preferredMedia(row.Media ?? []);
	if (!media) {
		return [];
	}

	const parts = media.Part.map((part, index) => {
		const duration = typeof part.duration === 'number'
			? part.duration
			: media.Part.length === 1 && typeof media.duration === 'number'
				? media.duration
				: null;
		return projectPart(part, index === 0 ? row.Chapter : undefined, duration);
	});

	const kind = typeKey === 'shows' ? 'episode' : typeKey === 'other' ? 'other' : 'movie';
	const showId = row.grandparentRatingKey;
	return [{
		id: row.ratingKey,
		etag: String(row.updatedAt ?? row.addedAt ?? row.ratingKey),
		kind,
		title: row.title,
		sortTitle: row.titleSort ?? null,
		plot: row.summary ?? null,
		year: typeof row.year === 'number' ? row.year : null,
		show: kind === 'episode' && showId ? {
			id: showId,
			title: row.grandparentTitle || 'Show',
			year: null,
			plot: null,
			posterPath: imagePath(row.grandparentThumb),
			fanartPath: imagePath(row.grandparentArt),
		} : null,
		seasonNumber: kind === 'episode' && typeof row.parentIndex === 'number' ? row.parentIndex : null,
		seasonTitle: row.parentTitle ?? null,
		episodeNumber: kind === 'episode' && typeof row.index === 'number' ? row.index : null,
		artists: [],
		album: null,
		albumId: null,
		trackNumber: null,
		genres: (row.Genre ?? []).flatMap((genre) => genre.tag ? [genre.tag] : []),
		directors: (row.Director ?? []).flatMap((director) => director.tag ? [director.tag] : []),
		actors: (row.Role ?? []).flatMap((role, index) => role.tag ? [{
			name: role.tag,
			role: role.role ?? null,
			sortOrder: index,
		}] : []),
		externalIds: (row.Guid ?? []).flatMap(projectGuid),
		parts,
		posterPath: imagePath(row.thumb),
		landscapePath: null,
		fanartPath: imagePath(row.art),
		modifiedAt: new Date((row.updatedAt ?? row.addedAt ?? 0) * 1000).toISOString(),
		metadata: {
			edition: row.editionTitle ?? null,
			originalTitle: row.originalTitle ?? null,
			releaseDate: row.originallyAvailableAt ?? null,
			rating: row.audienceRating ?? row.rating ?? null,
			userRating: row.userRating ?? null,
			certification: row.contentRating ?? null,
			writers: (row.Writer ?? []).flatMap(writer => writer.tag ? [writer.tag] : []),
			studios: row.studio ? [row.studio] : [],
			countries: (row.Country ?? []).flatMap(country => country.tag ? [country.tag] : []),
			tags: (row.Label ?? []).flatMap(label => label.tag ? [label.tag] : []),
		},
	}];
}

/** Keep a root-relative Plex image path. */
function imagePath(value: string | undefined): string | null {
	return value && value.startsWith('/') ? value : null;
}

/** Translate Plex guid strings such as imdb://tt1 into catalog external ids. */
function projectGuid(guid: { id?: string }): Array<{ provider: string; value: string }> {
	const id = guid.id ?? '';
	const separator = id.indexOf('://');
	if (separator <= 0) {
		return [];
	}

	const provider = id.slice(0, separator).toLowerCase();
	const value = id.slice(separator + 3);
	if (!['imdb', 'tmdb', 'tvdb'].includes(provider) || !value) {
		return [];
	}

	return [{ provider, value }];
}

/** Parse a Plex container-total header. An empty header is not zero. */
function numberedHeader(value: string | null): number | undefined {
	return value ? Number(value) : undefined;
}

/** Map one Plex part, including provider chapters on the first part. */
function projectPart(part: PlexPart, providerChapters: PlexMetadata['Chapter'], duration: number | null): RemotePart {
	const chapters = (providerChapters ?? []).flatMap((chapter, index, all) => {
		if (typeof chapter.startTimeOffset !== 'number') {
			return [];
		}

		const startSeconds = chapter.startTimeOffset / 1_000;
		const next = all[index + 1]?.startTimeOffset;
		const finishSeconds = typeof chapter.endTimeOffset === 'number'
			? chapter.endTimeOffset / 1_000
			: typeof next === 'number'
				? next / 1_000
				: duration === null ? startSeconds : duration / 1_000;
		return [{ startSeconds, finishSeconds, title: chapter.title ?? chapter.tag ?? '' }];
	});
	return {
		id: String(part.id),
		filePath: part.file ?? null,
		durationMilliseconds: duration,
		sizeBytes: typeof part.size === 'number' ? part.size : null,
		container: part.container ?? null,
		streams: (part.Stream ?? []).flatMap(projectStream),
		chapters,
	};
}

/** Reject unusable or repeated file identities within one ordered Plex version. */
function hasDistinctPartIds(parts: PlexPart[]): boolean {
	const ids = new Set<string>();
	for (const part of parts) {
		const id = part?.id;
		if (typeof id === 'number' ? !Number.isSafeInteger(id) || id < 0 : typeof id !== 'string' || !/^\d+$/u.test(id)) {
			return false;
		}

		const key = String(id).replace(/^0+(?=\d)/u, '');
		if (ids.has(key)) {
			return false;
		}
		ids.add(key);
	}
	return true;
}

/**
 * Rank versions whose files are all identified. A malformed listing with no usable alternate
 * aborts the scan so the indexed title cannot be treated as missing.
 */
function preferredMedia(versions: PlexMedia[]): IdentifiedPlexMedia | undefined {
	let chosen: IdentifiedPlexMedia | undefined;
	let chosenRank = -1;
	let incomplete = false;
	for (const media of versions) {
		const parts = media.Part;
		if (parts == null || (Array.isArray(parts) && parts.length === 0)) {
			continue;
		}
		if (!Array.isArray(parts) || !hasDistinctPartIds(parts)) {
			incomplete = true;
			continue;
		}

		const rank = mediaRank(media);
		if (!chosen || rank > chosenRank) {
			chosen = { ...media, Part: parts };
			chosenRank = rank;
		}
	}

	if (!chosen && incomplete) {
		throw new MediaServerRequestError('Plex did not identify every file in a media version');
	}
	return chosen;
}

/** Rank a version by picture size, then bitrate. Equal ranks keep the earlier version. */
function mediaRank(media: PlexMedia): number {
	const width = typeof media.width === 'number' && media.width > 0 ? media.width : 0;
	const height = typeof media.height === 'number' && media.height > 0 ? media.height : 0;
	const bitrate = typeof media.bitrate === 'number' && media.bitrate > 0 ? media.bitrate : 0;
	return width * height * 1_000_000 + bitrate;
}

/** Map a Plex stream type number onto video, audio, or subtitle. */
function projectStream(stream: PlexStream): RemoteStream[] {
	const type = stream.streamType === 1 ? 'video' : stream.streamType === 2 ? 'audio' : stream.streamType === 3 ? 'subtitle' : null;
	if (!type || stream.index === undefined) {
		return [];
	}

	// A /library/streams key is a sidecar. Its index is not a stream in the video file.
	if (type === 'subtitle' && stream.key?.includes('/library/streams/')) {
		return [];
	}

	return [{
		index: stream.index,
		type,
		codec: stream.codec ?? null,
		language: stream.languageTag ?? stream.language ?? null,
		title: stream.title ?? null,
		channels: stream.channels ?? null,
		width: stream.width ?? null,
		height: stream.height ?? null,
		isDefault: Boolean(stream.default ?? stream.selected),
		isForced: Boolean(stream.forced),
		isHearingImpaired: Boolean(stream.hearingImpaired),
		isCommentary: Boolean(stream.comment),
		isAttachedPicture: false,
	}];
}
