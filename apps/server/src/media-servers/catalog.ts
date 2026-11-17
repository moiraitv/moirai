import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { MediaPart, MediaServerPathReplacement, MediaSubtitleTrack } from '@moirai/shared';
import { catalogSortTitle, remotePlaybackReference } from '@moirai/shared';
import { chapterInputExceedsLimit, normalizeMediaChapters } from '../media/chapters.js';
import { mediaProbeFingerprint, type MediaProbe, type MediaProbeResult } from '../media/media-probe.js';
import { mediaFileFingerprint } from '../media/file-fingerprint.js';
import { attachMediaIssueIdentities } from '../scanner/media-issue-identity.js';
import type { CatalogConflictObservation, DiscoveredGroup, DiscoveredItem, MediaProbeCacheEntry } from '../repository/contracts.js';
import { normalizeGenres, normalizePeople, primaryGenreKey, titleBucket } from '../scanner/catalog-metadata.js';
import { deterministicId } from '../scanner/catalog-identity.js';
import { normalizedItemMetadata } from '../scanner/item-fingerprint.js';
import { stableJsonFingerprint } from '../stable-json.js';
import { remoteCatalogMetadata } from './metadata.js';
import { groupLooseMusicVideos } from '../scanner/music-video-groups.js';
import { assessDurationHealth, type TailInspector } from '../scanner/media-duration-health.js';
import { discoverSidecarSubtitles, embeddedSubtitleTracks } from '../scanner/subtitles.js';
import type { ScanIssue } from '@moirai/shared';
import { localPathForRemote } from './paths.js';
import type { RemoteMediaItem, RemotePart, RemoteStream } from './items.js';

/** Provider image path stored in artwork columns and fetched with the server credential. */
export const PROVIDER_IMAGE_PREFIX = 'provider-image:';

/** Metadata version mixed into remote item fingerprints. */
const METADATA_VERSION = 2;

/** Discovery produced from one remote library listing. */
export interface RemoteCatalog {
	groups: DiscoveredGroup[];
	items: DiscoveredItem[];
	issues: ScanIssue[];
	conflicts: CatalogConflictObservation[];
}

/**
 * Turn provider items into the catalog records the scanner already persists.
 * A path replacement that names an existing file keeps the normal local playback path.
 */
export async function buildRemoteCatalog(input: {
	libraryId: string;
	mediaServerId: string;
	items: RemoteMediaItem[];
	replacements: MediaServerPathReplacement[];
	probe?: MediaProbe;
	probeCache?: Map<string, MediaProbeCacheEntry>;
	signal?: AbortSignal;
	tailAssessments?: Map<string, NonNullable<ScanIssue['tailAssessment']>>;
	inspectTail?: TailInspector;
}): Promise<RemoteCatalog> {
	const groups = new Map<string, DiscoveredGroup>();
	const items: DiscoveredItem[] = [];
	const issues: ScanIssue[] = [];
	const showIds = new Map<string, string[]>();
	const seenIds = new Set<string>();
	for (const remote of input.items) {
		input.signal?.throwIfAborted();
		if (seenIds.has(remote.id)) {
			issues.push({
				path: remote.id,
				code: 'duplicate_remote_item',
				message: 'The media server listed this item more than once. The extra copy was skipped.',
				severity: 'warning',
			});
			continue;
		}

		seenIds.add(remote.id);
		const built = await buildItem(remote, input, issues);
		if (!built) {
			continue;
		}

		if (remote.show) {
			const show = ensureShow(input.libraryId, groups, remote);
			const season = ensureSeason(input.libraryId, groups, show, remote);
			built.groupId = season?.id ?? show.id;
			const externalId = remote.externalIds.find((entry) => entry.provider === 'tvdb' || entry.provider === 'imdb');
			if (externalId && remote.kind === 'episode') {
				const key = `${externalId.provider}:${externalId.value}`;
				const paths = showIds.get(key) ?? [];
				if (!paths.includes(show.title)) {
					paths.push(show.title);
				}
				showIds.set(key, paths);
			}
		}

		items.push(built);
	}

	// Loose music videos have no show group. Movies and other videos stay ungrouped.
	const musicVideos = items.filter((item) => item.kind === 'music-video');
	if (musicVideos.length > 0) {
		groupLooseMusicVideos(input.libraryId, groups, musicVideos);
	}
	const conflicts: CatalogConflictObservation[] = [];
	for (const [key, paths] of showIds) {
		if (paths.length < 2) {
			continue;
		}

		const [provider, externalId] = key.split(':');
		conflicts.push({
			conflictKey: `show-external-id:${key}`,
			kind: 'show-external-id',
			provider: provider ?? '',
			externalId: externalId ?? '',
			paths,
			message: `More than one show uses ${provider} id ${externalId}`,
		});
	}

	// Include every final persisted field so metadata-only changes refresh without a new provider etag.
	for (const item of items) {
		item.fingerprint = stableJsonFingerprint({
			sourceFingerprint: item.fingerprint,
			normalizedMetadata: normalizedItemMetadata(item),
		});
	}
	return { groups: [...groups.values()], items, issues, conflicts };
}

/** Build one discovered item, probing a mapped local file when it exists. */
async function buildItem(
	remote: RemoteMediaItem,
	input: {
		libraryId: string;
		mediaServerId: string;
		replacements: MediaServerPathReplacement[];
		probe?: MediaProbe;
		probeCache?: Map<string, MediaProbeCacheEntry>;
		signal?: AbortSignal;
		tailAssessments?: Map<string, NonNullable<ScanIssue['tailAssessment']>>;
		inspectTail?: TailInspector;
	},
	issues: ScanIssue[],
): Promise<DiscoveredItem | null> {
	const parts: MediaPart[] = [];
	const technicalParts: Array<Record<string, unknown>> = [];
	let durationMilliseconds = 0;
	let sawDuration = false;
	let probeFailed = false;
	const subtitleTracks: MediaSubtitleTrack[] = [];
	const located = [];
	for (const [index, remotePart] of remote.parts.entries()) {
		located.push({
			index,
			remotePart,
			...await locateMappedFile(remotePart, input.replacements),
		});
	}

	const localProbeKey = localProbeFingerprint(located);
	const cached = localProbeKey ? input.probeCache?.get(remote.id) : undefined;
	const cachedParts = cached
		&& cached.probeStatus === 'complete'
		&& cached.probeFingerprint === localProbeKey
		&& Array.isArray(cached.technicalMetadata.parts)
		&& cached.technicalMetadata.parts.length === located.length
		? cached.technicalMetadata.parts as Array<Record<string, unknown>>
		: null;
	for (const entry of located) {
		const resolved = await resolvePart(
			remote,
			entry.remotePart,
			entry.index + 1,
			entry.localFile,
			entry.issueFingerprint,
			cachedParts?.[entry.index] ?? null,
			input,
			issues,
		);
		parts.push(resolved.part);
		technicalParts.push(resolved.technical);
		subtitleTracks.push(...resolved.subtitles);
		probeFailed = probeFailed || resolved.probeFailed;
		if (resolved.part.durationSeconds !== null) {
			durationMilliseconds += Math.round(resolved.part.durationSeconds * 1_000);
			sawDuration = true;
		}
	}

	if (parts.length === 0) {
		return null;
	}

	const relativePath = remote.id;
	const sortTitle = catalogSortTitle(remote.title, remote.sortTitle);
	const metadata = remoteCatalogMetadata(remote);
	const genres = normalizeGenres(metadata.genres);
	const people = normalizePeople(metadata.directors, metadata.actors);
	const externalIds = remote.externalIds.map((entry, index) => ({ ...entry, isDefault: index === 0 }));
	const poster = imageReference(remote.posterPath);
	const landscape = imageReference(remote.landscapePath);
	const fanart = imageReference(remote.fanartPath);
	const artworkFingerprint = createHash('sha256')
		.update([poster, landscape, fanart].join('\n'))
		.digest('hex');
	const fingerprint = createHash('sha256').update(JSON.stringify({
		version: METADATA_VERSION,
		etag: remote.etag,
		title: remote.title,
		paths: parts.map((part) => part.playbackPath),
		plot: remote.plot,
		year: remote.year,
		genres,
		people,
	})).digest('hex');
	const primary = technicalParts[0] ?? {};
	return {
		id: deterministicId(input.libraryId, remote.id),
		aliasIds: [],
		groupId: null,
		stableKey: remote.id,
		kind: remote.kind,
		title: remote.title,
		sortTitle,
		relativePath,
		playbackPath: parts[0]!.playbackPath,
		nfoRelativePath: null,
		plot: remote.plot,
		year: remote.year,
		durationMilliseconds: sawDuration ? durationMilliseconds : null,
		probeFingerprint: localProbeKey ?? remote.etag,
		probeStatus: probeFailed ? 'failed' : 'complete',
		probeUpdatedAt: remote.modifiedAt,
		probeErrorCode: probeFailed ? 'media_probe_failed' : null,
		technicalMetadata: {
			...primary,
			parts: technicalParts,
		},
		seasonNumber: remote.seasonNumber,
		episodeNumber: remote.episodeNumber,
		episodeEndNumber: null,
		edition: remote.kind === 'movie' ? metadata.edition : null,
		externalIds,
		trackNumber: remote.trackNumber,
		discNumber: null,
		artists: metadata.artists,
		multipartStatus: parts.length < 2 ? 'none' : parts.every((part) => part.durationSeconds !== null) ? 'complete' : 'incomplete',
		parts,
		subtitleTracks,
		metadataStatus: remote.plot || remote.year || genres.length ? 'complete' : 'incomplete',
		metadata: {
			...metadata,
			externalIds,
			artworkFingerprint,
		},
		artworkRelativePath: poster,
		posterRelativePath: poster,
		landscapeRelativePath: landscape,
		fanartRelativePath: fanart,
		fingerprint,
		fileModifiedAt: remote.modifiedAt,
		titleBucket: titleBucket(sortTitle),
		primaryGenreKey: primaryGenreKey(metadata, metadata.genres),
		genres,
		people,
	};
}

/** Capture probe-cache and stable issue identities together from the mapped file stat. */
async function locateMappedFile(
	part: RemotePart,
	replacements: MediaServerPathReplacement[],
): Promise<{ localFile: string | null; fileFingerprint: string | null; issueFingerprint: string | null }> {
	const mapped = part.filePath ? localPathForRemote(replacements, part.filePath) : null;
	if (!mapped) {
		return { localFile: null, fileFingerprint: null, issueFingerprint: null };
	}

	try {
		const info = await stat(mapped);
		if (!info.isFile()) {
			return { localFile: null, fileFingerprint: null, issueFingerprint: null };
		}

		return { localFile: mapped, fileFingerprint: mediaProbeFingerprint(info), issueFingerprint: mediaFileFingerprint(info) };
	}
	catch {
		return { localFile: null, fileFingerprint: null, issueFingerprint: null };
	}
}

/** Fingerprint every located file so one changed part invalidates the cached probe. */
function localProbeFingerprint(located: Array<{ remotePart: RemotePart; fileFingerprint: string | null }>): string | null {
	if (!located.some((entry) => entry.fileFingerprint)) {
		return null;
	}

	return createHash('sha256')
		.update(located.map((entry) => `${entry.remotePart.id}:${entry.fileFingerprint ?? ''}`).join('\n'))
		.digest('hex');
}

/** Rebuild a probe result stored on a previous catalog row. */
function probeFromTechnical(technical: Record<string, unknown>): MediaProbeResult | null {
	if (typeof technical.durationMilliseconds !== 'number') {
		return null;
	}

	const chapters = Array.isArray(technical.chapters)
		? technical.chapters as NonNullable<MediaProbeResult['chapters']>
		: null;
	return {
		durationMilliseconds: technical.durationMilliseconds,
		...(chapters ? { chapters } : {}),
		chapterLimitExceeded: technical.chapterLimitExceeded === true,
		fileSizeBytes: typeof technical.fileSizeBytes === 'number' ? technical.fileSizeBytes : 0,
		container: typeof technical.container === 'string' ? technical.container : null,
		streams: Array.isArray(technical.streams) ? technical.streams as MediaProbeResult['streams'] : [],
		resolution: technical.resolution && typeof technical.resolution === 'object'
			? technical.resolution as MediaProbeResult['resolution']
			: null,
		tags: {},
	};
}

/** Choose a local file or a remote playback reference for one part. */
async function resolvePart(
	remote: RemoteMediaItem,
	part: RemotePart,
	number: number,
	localFile: string | null,
	issueFingerprint: string | null,
	reuseTechnical: Record<string, unknown> | null,
	input: {
		mediaServerId: string;
		probe?: MediaProbe;
		signal?: AbortSignal;
		tailAssessments?: Map<string, NonNullable<ScanIssue['tailAssessment']>>;
		inspectTail?: TailInspector;
	},
	issues: ScanIssue[],
): Promise<{ part: MediaPart; technical: Record<string, unknown>; subtitles: MediaSubtitleTrack[]; probeFailed: boolean }> {
	const displayPath = part.filePath?.replace(/\\/g, '/') || `${remote.id}:${part.id}`;
	let probe = reuseTechnical ? probeFromTechnical(reuseTechnical) : null;
	const reusedProbe = probe !== null;
	const mappedIssues: ScanIssue[] = [];
	let probeFailed = false;
	if (localFile && issueFingerprint) {
		try {
			if (!probe && input.probe) {
				probe = await input.probe.probe(path.dirname(localFile), path.basename(localFile), input.signal);
			}

			if (probe) {
				mappedIssues.push(...await assessDurationHealth(probe, {
					root: path.dirname(localFile),
					file: path.basename(localFile),
					relativePath: displayPath,
					fingerprint: issueFingerprint,
					cached: reusedProbe ? input.tailAssessments?.get(displayPath) : undefined,
					inspect: input.inspectTail,
					signal: input.signal,
				}));
			}
		}
		catch (error) {
			probeFailed = true;
			mappedIssues.push({
				path: displayPath,
				code: 'media_probe_failed',
				message: error instanceof Error ? error.message : 'Mapped media file could not be probed.',
				severity: 'warning',
			});
		}

		// Bind ignore decisions to the observed file without another filesystem read.
		if (mappedIssues.length) {
			await attachMediaIssueIdentities(path.dirname(localFile), mappedIssues, [], [], {
				media: new Map([[displayPath, issueFingerprint]]), metadata: new Map(), sidecars: new Map(),
			}, input.signal);
		}
		issues.push(...mappedIssues);
	}

	const durationMilliseconds = probe?.durationMilliseconds ?? part.durationMilliseconds;
	const chapters = probe?.chapters ?? normalizeMediaChapters(part.chapters, (durationMilliseconds ?? 0) / 1_000);
	const streams = probe?.streams ?? part.streams.map(streamAsProbe);
	const technical = {
		fileSizeBytes: probe?.fileSizeBytes ?? part.sizeBytes,
		container: probe?.container ?? part.container,
		streams,
		chapters,
		chapterLimitExceeded: probe?.chapterLimitExceeded ?? chapterInputExceedsLimit(part.chapters),
		resolution: probe?.resolution ?? resolutionOf(part.streams),
		durationMilliseconds,
	};
	const playbackPath = localFile ?? remotePlaybackReference(input.mediaServerId, part.id);
	const subtitles = [
		...embeddedSubtitleTracks(probe ?? { streams: streams as MediaProbeResult['streams'], durationMilliseconds: durationMilliseconds ?? 0, fileSizeBytes: 0, container: null, resolution: null, tags: {} }, number, displayPath),
	];
	if (localFile) {
		const stem = localFile.slice(0, -path.extname(localFile).length);
		const sidecars = await discoverSidecarSubtitles(path.dirname(localFile), stem, [{ stem, partNumber: number }], (relative) => path.join(path.dirname(localFile), relative));
		subtitles.push(...sidecars.map((entry) => ({
			...entry.track,
			id: stableJsonFingerprint({ server: input.mediaServerId, item: remote.id, part: part.id, sidecar: entry.track.id }).slice(0, 32),
		})));
	}

	return {
		part: {
			number,
			kind: null,
			relativePath: displayPath,
			playbackPath,
			durationSeconds: durationMilliseconds === null ? null : durationMilliseconds / 1_000,
			subtitleTracks: subtitles,
		},
		technical,
		subtitles,
		probeFailed,
	};
}

/** Adapt a provider stream to the probe stream shape used by playback selection. */
function streamAsProbe(stream: RemoteStream): MediaProbeResult['streams'][number] {
	return {
		index: stream.index,
		type: stream.type,
		codec: stream.codec,
		durationMilliseconds: null,
		width: stream.width,
		height: stream.height,
		channels: stream.channels,
		language: stream.language,
		title: stream.title,
		isDefault: stream.isDefault,
		isForced: stream.isForced,
		isHearingImpaired: stream.isHearingImpaired,
		isCommentary: stream.isCommentary,
		isAttachedPicture: stream.isAttachedPicture,
	};
}

/** Read the first video stream's dimensions. */
function resolutionOf(streams: RemoteStream[]): { width: number; height: number } | null {
	const video = streams.find((stream) => stream.type === 'video' && stream.width && stream.height);
	return video?.width && video.height ? { width: video.width, height: video.height } : null;
}

/** Prefix a provider image path so the artwork route does not treat it as a library file. */
function imageReference(imagePath: string | null): string | null {
	return imagePath ? `${PROVIDER_IMAGE_PREFIX}${imagePath}` : null;
}

/** Create or reuse the show group for an episode. */
function ensureShow(libraryId: string, groups: Map<string, DiscoveredGroup>, remote: RemoteMediaItem): DiscoveredGroup {
	const show = remote.show!;
	const stableKey = `show:${show.id}`;
	const existing = groups.get(stableKey);
	if (existing) {
		return existing;
	}

	const poster = imageReference(show.posterPath);
	const fanart = imageReference(show.fanartPath);
	const created: DiscoveredGroup = {
		id: deterministicId(libraryId, stableKey),
		stableKey,
		sourceKey: stableKey,
		parentId: null,
		kind: 'show',
		title: show.title,
		sortTitle: catalogSortTitle(show.title),
		year: show.year,
		plot: show.plot,
		metadata: { artworkFingerprint: createHash('sha256').update(`${poster ?? ''}:${fanart ?? ''}`).digest('hex') },
		artworkRelativePath: poster,
		posterRelativePath: poster,
		landscapeRelativePath: null,
		fanartRelativePath: fanart,
	};
	groups.set(stableKey, created);
	return created;
}

/** Create or reuse the season group under a show. */
function ensureSeason(
	libraryId: string,
	groups: Map<string, DiscoveredGroup>,
	show: DiscoveredGroup,
	remote: RemoteMediaItem,
): DiscoveredGroup | null {
	if (remote.seasonNumber === null) {
		return null;
	}

	const stableKey = `season:${remote.show!.id}:${remote.seasonNumber}`;
	const existing = groups.get(stableKey);
	if (existing) {
		return existing;
	}

	const title = remote.seasonTitle?.trim() || `Season ${remote.seasonNumber}`;
	const created: DiscoveredGroup = {
		id: deterministicId(libraryId, stableKey),
		stableKey,
		sourceKey: stableKey,
		parentId: show.id,
		kind: 'season',
		title,
		sortTitle: catalogSortTitle(title),
		year: null,
		plot: null,
		metadata: {},
		artworkRelativePath: null,
		posterRelativePath: null,
		landscapeRelativePath: null,
		fanartRelativePath: null,
	};
	groups.set(stableKey, created);
	return created;
}
