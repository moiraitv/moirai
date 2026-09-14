import { createHash } from 'node:crypto';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
	MAX_NFO_BYTES,
	MEDIA_EXTENSIONS,
	type Library,
	type MediaExternalId,
	type MediaPart,
	type ScanIssue,
	type ScanProgress,
	type SourceIdentity,
} from '@moirai/shared';
import { deterministicId } from './catalog-identity.js';
import { inheritMusicArtistArtwork } from './music-video-artwork.js';
import { groupLooseMusicVideos } from './music-video-groups.js';
import { internalErrorMessage } from '../error-message.js';
import { ARTWORK_EXTENSIONS } from '../artwork/artwork-formats.js';
import { isPathWithinRoot } from '../media/path-boundary.js';
import type {
	CatalogConflictObservation,
	DiscoveredGroup,
	DiscoveredItem,
} from '../repository/contracts.js';
import {
	catalogSortTitle,
	normalizeGenres,
	normalizePeople,
	ON_DISK_METADATA_VERSION,
	titleBucket,
} from './catalog-metadata.js';
import { parseKodiNfo, type ParsedNfo } from './nfo.js';
import { openSourceFile, readSourceFile, SourceFileError } from '../media/source-file.js';
import {
	mediaProbeFingerprint,
	MediaProbeError,
	type MediaProbeResult,
} from '../media/media-probe.js';
import type { MediaProbeCacheEntry } from '../repository/contracts.js';
import { currentTimestamp } from '../time.js';
import { stableJsonFingerprint } from '../stable-json.js';
import {
	discoverSidecarSubtitles,
	embeddedSubtitleTracks,
	type LocatedSubtitleTrack,
} from './subtitles.js';
import { normalizedItemMetadata } from './item-fingerprint.js';
import {
	parseCollectionFolder,
	parseVideoFilename,
	type ParsedVideoFilename,
} from './video-filename.js';
import { collapseMultipartItems } from './multipart.js';
import { runScanQueue, type ScanFileOutcome } from './scan-queue.js';
import type {
	MissingItemPresenceCheck,
	MissingItemPresenceTarget,
	ScanDiscovery,
} from './contracts.js';

/** Cancellation and limit controls applied while walking a library. */
interface DiscoveryOptions {
	statFile?: typeof stat;
	openDirectory?: typeof opendir;
	signal?: AbortSignal;
	probeCache?: Map<string, MediaProbeCacheEntry>;
	probeMedia?: (scanRoot: string, file: string, signal?: AbortSignal) => Promise<MediaProbeResult>;
	discoveryConcurrency?: number;
	onProgress?: (progress: ScanProgress) => void;
}

/** Stop scan traversal promptly after cooperative cancellation. */
function throwIfCancelled(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

/** Normalize a relative media path to portable forward slashes. */
function normalizeRelative(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join('/');
}

/** Resolve the configured root to the filesystem identity used for reconciliation. */
export async function identifyOnDiskSource(
	scanRoot: string,
	signal?: AbortSignal,
): Promise<SourceIdentity> {
	throwIfCancelled(signal);
	const canonicalRoot = await realpath(scanRoot);
	throwIfCancelled(signal);
	const info = await stat(canonicalRoot, { bigint: true });
	if (!info.isDirectory()) {
		throw new Error('The configured scan root is not a directory');
	}

	return {
		sourceType: 'on-disk',
		sourceKey: canonicalRoot,
		details: {
			canonicalRoot,
			device: String(info.dev),
			inode: String(info.ino),
		},
	};
}

/** Check only previously indexed physical media paths without traversing or reading the source. */
export async function checkOnDiskPresence(
	scanRoot: string,
	targets: MissingItemPresenceTarget[],
	signal?: AbortSignal,
): Promise<MissingItemPresenceCheck> {
	const sourceIdentity = await identifyOnDiskSource(scanRoot, signal);
	const observations = [] as MissingItemPresenceCheck['observations'];
	for (const target of targets) {
		let sawInconclusive = false;
		let present = false;
		for (const relativePath of target.relativePaths) {
			throwIfCancelled(signal);
			try {
				const source = await openSourceFile(scanRoot, relativePath);
				await source.handle.close();
				present = true;
				break;
			}
			catch (error) {
				if (signal?.aborted) {
					throw error;
				}

				if (
					!(error instanceof SourceFileError)
					|| !['missing', 'not-file', 'symlink'].includes(error.reason)
				) {
					sawInconclusive = true;
				}
			}
		}

		observations.push({
			itemId: target.itemId,
			status: present ? 'present' : sawInconclusive ? 'inconclusive' : 'absent',
		});
	}

	return { sourceIdentity, observations };
}

/** Return the first readable non-symlink file from the candidates. */
async function existingFile(candidates: string[], signal?: AbortSignal): Promise<string | null> {
	for (const candidate of candidates) {
		throwIfCancelled(signal);
		try {
			if ((await lstat(candidate)).isFile()) {
				return candidate;
			}
		}
		catch {
			// Missing artwork is expected and handled by the SPA placeholder.
		}
	}
	return null;
}

/** Resolve conventional artwork without crossing the library boundary. */
async function existingArtwork(stems: string[], signal?: AbortSignal): Promise<string | null> {
	return existingFile(
		stems.flatMap((stem) => ARTWORK_EXTENSIONS.map((extension) => `${stem}${extension}`)),
		signal,
	);
}

/** Traverse the library tree without following symlinks. */
async function walk(
	root: string,
	issues: ScanIssue[],
	signal?: AbortSignal,
	openDirectory: typeof opendir = opendir,
): Promise<{ files: string[]; complete: boolean }> {
	const files = new Set<string>();
	const visitedDirectories = new Set<string>();
	let complete = true;
	/** Inspect one directory entry during cancellable traversal. */
	async function visit(directory: string, isRoot = false): Promise<void> {
		const normalizedDirectory = path.normalize(directory);
		if (visitedDirectories.has(normalizedDirectory)) {
			return;
		}

		visitedDirectories.add(normalizedDirectory);
		try {
			throwIfCancelled(signal);
			const entries = await openDirectory(directory);
			for await (const entry of entries) {
				throwIfCancelled(signal);
				if (entry.name.startsWith('.')) {
					continue;
				}

				const absolute = path.join(directory, entry.name);
				if (entry.isSymbolicLink()) {
					continue;
				}

				if (entry.isDirectory()) {
					await visit(absolute);
				}
				else if (
					entry.isFile()
					&& MEDIA_EXTENSIONS.includes(
						path.extname(entry.name).toLowerCase() as (typeof MEDIA_EXTENSIONS)[number],
					)
				) {
					files.add(path.normalize(absolute));
				}
			}
		}
		catch (error) {
			if (signal?.aborted) {
				throw error;
			}

			if (isRoot) {
				throw error;
			}

			complete = false;
			issues.push({
				path: normalizeRelative(root, directory),
				code: 'directory_unreadable',
				message: internalErrorMessage(error),
				severity: 'error',
			});
		}
	}
	await visit(root, true);
	return { files: [...files], complete };
}

/** Retrieve nfo for the library scan. */
async function readNfo(
	file: string,
	scanRoot: string,
	logicalStem: string,
	typeKey: string,
	signal?: AbortSignal,
): Promise<{
	parsed: ParsedNfo | null;
	path: string | null;
	status: 'complete' | 'incomplete' | 'invalid';
	issue: ScanIssue | null;
}> {
	const stem = file.slice(0, -path.extname(file).length);
	const candidates = [
		`${logicalStem}.nfo`,
		...(logicalStem === stem ? [] : [`${stem}.nfo`]),
		...(typeKey === 'movies' ? [path.join(path.dirname(file), 'movie.nfo')] : []),
	];
	const nfoPath = await existingFile(candidates, signal);
	if (!nfoPath) {
		return {
			parsed: null,
			path: null,
			status: 'incomplete',
			issue: {
				path: file,
				code: 'nfo_missing',
				message: 'No sidecar NFO was found; metadata was derived from the filename.',
				severity: 'warning',
			},
		};
	}

	try {
		const source = await readSourceFile(scanRoot, nfoPath, MAX_NFO_BYTES, signal);
		return {
			parsed: parseKodiNfo(source.content.toString('utf8')),
			path: source.path,
			status: 'complete',
			issue: null,
		};
	}
	catch (error) {
		if (signal?.aborted) {
			throw error;
		}

		const tooLarge = error instanceof SourceFileError && error.reason === 'too-large';
		return {
			parsed: null,
			path: nfoPath,
			status: 'invalid',
			issue: {
				path: nfoPath,
				code: tooLarge ? 'nfo_too_large' : 'nfo_invalid',
				message: tooLarge
					? `NFO exceeds the ${MAX_NFO_BYTES} byte ingestion limit.`
					: internalErrorMessage(error),
				severity: 'warning',
			},
		};
	}
}

/** Retrieve group-level NFO metadata for the library scan. */
async function readGroupNfo(
	file: string,
	scanRoot: string,
	issues: ScanIssue[],
	signal?: AbortSignal,
): Promise<ParsedNfo | null> {
	try {
		const source = await readSourceFile(scanRoot, file, MAX_NFO_BYTES, signal);
		const parsed = parseKodiNfo(source.content.toString('utf8'));
		if (parsed.truncatedFields.length > 0) {
			issues.push({
				path: normalizeRelative(scanRoot, file),
				code: 'metadata_truncated',
				message: `Metadata exceeded documented limits: ${parsed.truncatedFields.join(', ')}.`,
				severity: 'warning',
			});
		}
		if (parsed.invalidFields.length > 0) {
			issues.push({
				path: normalizeRelative(scanRoot, file),
				code: 'metadata_invalid',
				message: `Invalid metadata values were ignored: ${parsed.invalidFields.join(', ')}.`,
				severity: 'warning',
			});
		}
		return parsed;
	}
	catch (error) {
		if (signal?.aborted) {
			throw error;
		}

		if (error instanceof SourceFileError && error.reason === 'missing') {
			return null;
		}

		const tooLarge = error instanceof SourceFileError && error.reason === 'too-large';
		issues.push({
			path: normalizeRelative(scanRoot, file),
			code: tooLarge ? 'nfo_too_large' : 'tvshow_nfo_invalid',
			message: tooLarge
				? `NFO exceeds the ${MAX_NFO_BYTES} byte ingestion limit.`
				: internalErrorMessage(error),
			severity: 'warning',
		});
		return null;
	}
}

/** Deduplicate provider identifiers while preferring explicit NFO defaults. */
function mergedExternalIds(
	primary: MediaExternalId[],
	fallback: MediaExternalId[],
): MediaExternalId[] {
	const ids = new Map<string, MediaExternalId>();
	for (const id of [...primary, ...fallback]) {
		const key = `${id.provider.toLocaleLowerCase('en-US')}:${id.value.toLocaleLowerCase('en-US')}`;
		if (!ids.has(key)) {
			ids.set(key, id);
		}
	}
	return [...ids.values()];
}

/** Parse the leading positive integer from a bounded container tag. */
function taggedNumber(value: string | undefined): number | null {
	const match = value?.match(/^\s*(\d{1,6})/);
	return match ? Number(match[1]) : null;
}

/** Split a conservative artist tag without breaking ordinary names containing commas. */
function taggedArtists(value: string | undefined): string[] {
	return value
		? [...new Set(value.split(/\s*;\s*/).map((artist) => artist.trim()).filter(Boolean))]
		: [];
}

/** Resolve a safe local primary-artwork reference relative to its owning NFO. */
async function referencedArtwork(
	scanRoot: string,
	nfoPath: string | null,
	references: string[],
	signal?: AbortSignal,
): Promise<string | null> {
	if (!nfoPath) {
		return null;
	}

	const candidates = references.flatMap((reference) => {
		if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || path.isAbsolute(reference)) {
			return [];
		}

		const candidate = path.resolve(path.dirname(nfoPath), reference);
		return isPathWithinRoot(scanRoot, candidate) ? [candidate] : [];
	});
	return existingFile(candidates, signal);
}

/** Compute a stable identity used to compare scheduling inputs. */
async function fingerprint(
	scanRoot: string,
	paths: Array<string | null>,
	mediaFile: string,
	mediaInfo: Awaited<ReturnType<typeof stat>>,
	signal?: AbortSignal,
	technicalIdentity?: string,
): Promise<string> {
	const details: string[] = [`metadata:${ON_DISK_METADATA_VERSION}`];
	if (technicalIdentity) {
		details.push(`technical:${technicalIdentity}`);
	}
	for (const candidate of paths) {
		throwIfCancelled(signal);
		if (!candidate) {
			continue;
		}

		const info = candidate === mediaFile ? mediaInfo : await sourceStat(scanRoot, candidate);
		details.push(`${candidate}:${info.size}:${info.mtimeMs}`);
	}
	return createHash('sha256').update(details.join('|')).digest('hex');
}

/** Record artwork size and modification time for cache versioning. */
async function artworkFingerprint(scanRoot: string, file: string | null): Promise<string | null> {
	if (!file) {
		return null;
	}

	const info = await sourceStat(scanRoot, file);
	return createHash('sha256').update(`${info.size}:${info.mtimeMs}`).digest('hex');
}

/** Stat a regular source file through a no-follow descriptor and close it immediately. */
async function sourceStat(
	scanRoot: string,
	file: string,
): Promise<Awaited<ReturnType<typeof stat>>> {
	const source = await openSourceFile(scanRoot, file);
	try {
		return source.stat;
	}
	finally {
		await source.handle.close();
	}
}

/** Replace the local scan root with the path visible to the playback container. */
function playbackPath(library: Library, relativePath: string): string {
	const root = library.sourceConfig.playbackRoot ?? library.sourceConfig.scanRoot;
	return path.posix.join(root.split(path.sep).join('/'), relativePath);
}

/** Discover and normalize an on-disk Kodi-style library without mutating the index. */
export async function discoverOnDisk(
	library: Library,
	options: DiscoveryOptions = {},
): Promise<ScanDiscovery> {
	// Resolve and walk the source root before beginning per-file metadata work.
	const issues: ScanIssue[] = [];
	const signal = options.signal;
	const sourceIdentity = await identifyOnDiskSource(library.sourceConfig.scanRoot, signal);
	const scanRoot = sourceIdentity.details.canonicalRoot!;
	const walked = await walk(scanRoot, issues, signal, options.openDirectory);
	options.onProgress?.({
		phase: 'processing',
		processedCount: 0,
		totalCount: walked.files.length,
	});

	const items: DiscoveredItem[] = [];
	const groupsByKey = new Map<string, DiscoveredGroup>();
	const groupNfoCache = new Map<string, ParsedNfo | null>();
	let traversalComplete = walked.complete;
	let systemicProbeFailure: { code: string; message: string } | null = null;
	const statFile = options.statFile ?? stat;
	const parsedByFile = new Map(
		walked.files.map((file) => {
			const relativePath = normalizeRelative(scanRoot, file);
			return [file, parseVideoFilename(relativePath, library.typeKey)] as const;
		}),
	);
	const multipartFiles = new Map<string, string[]>();
	for (const file of walked.files) {
		const parsed = parsedByFile.get(file)!;
		if (!parsed.part) {
			continue;
		}

		const key = path.join(path.dirname(file), parsed.logicalStem).toLocaleLowerCase('en-US');
		multipartFiles.set(key, [...(multipartFiles.get(key) ?? []), file]);
	}
	const sidecarCache = new Map<string, Promise<LocatedSubtitleTrack[]>>();

	/** Resolve and cache sidecars for all physical sources in one logical item. */
	function sidecarsFor(file: string, parsed: ParsedVideoFilename): Promise<LocatedSubtitleTrack[]> {
		const logicalStem = path.join(path.dirname(file), parsed.logicalStem);
		const key = logicalStem.toLocaleLowerCase('en-US');
		const siblings = parsed.part ? (multipartFiles.get(key) ?? [file]) : [file];
		if (!sidecarCache.has(key)) {
			sidecarCache.set(key, discoverSidecarSubtitles(
				scanRoot,
				logicalStem,
				siblings.map((sibling) => ({
					stem: sibling.slice(0, -path.extname(sibling).length),
					partNumber: parsedByFile.get(sibling)?.part?.number ?? 1,
				})),
				(relativePath) => playbackPath(library, relativePath),
			));
		}
		return sidecarCache.get(key)!;
	}

	/** Defer failed probes before emitting a final media record and its metadata diagnostics. */
	async function discoverFile(file: string, canRetry: boolean): Promise<ScanFileOutcome> {
		// Open the media safely and reuse a technical probe when its fingerprint still matches.
		throwIfCancelled(signal);
		const mediaInfo = options.statFile ? await statFile(file) : await sourceStat(scanRoot, file);
		const relativePath = normalizeRelative(scanRoot, file);
		const filename = parsedByFile.get(file)!;
		const logicalStem = path.join(path.dirname(file), filename.logicalStem);
		const probeFingerprint = mediaProbeFingerprint(mediaInfo);
		const cachedProbe = options.probeCache?.get(relativePath);

		let probeResult: MediaProbeResult | null = null;
		let probeErrorCode: string | null = null;
		let probeUpdatedAt = currentTimestamp();
		if (
			cachedProbe?.probeStatus === 'complete'
			&& cachedProbe.probeFingerprint === probeFingerprint
			&& cachedProbe.durationMilliseconds !== null
		) {
			probeResult = {
				durationMilliseconds: cachedProbe.durationMilliseconds,
				fileSizeBytes: typeof cachedProbe.technicalMetadata.fileSizeBytes === 'number'
					? cachedProbe.technicalMetadata.fileSizeBytes
					: Number(mediaInfo.size),
				container: typeof cachedProbe.technicalMetadata.container === 'string'
					? cachedProbe.technicalMetadata.container
					: null,
				streams: Array.isArray(cachedProbe.technicalMetadata.streams)
					? cachedProbe.technicalMetadata.streams as MediaProbeResult['streams']
					: [],
				resolution: cachedProbe.technicalMetadata.resolution
					&& typeof cachedProbe.technicalMetadata.resolution === 'object'
					? cachedProbe.technicalMetadata.resolution as MediaProbeResult['resolution']
					: null,
				tags: cachedProbe.technicalMetadata.tags
					&& typeof cachedProbe.technicalMetadata.tags === 'object'
					? cachedProbe.technicalMetadata.tags as Record<string, string>
					: {},
			};
			probeUpdatedAt = cachedProbe.probeUpdatedAt ?? probeUpdatedAt;
		}
		else if (systemicProbeFailure) {
			probeErrorCode = systemicProbeFailure.code;
		}
		else if (options.probeMedia) {
			try {
				probeResult = await options.probeMedia(scanRoot, file, signal);
			}
			catch (error) {
				if (signal?.aborted) {
					throw error;
				}

				probeErrorCode = error instanceof MediaProbeError ? error.code : 'probe-failed';
				const systemic = ['executable-unavailable', 'resource-exhausted'].includes(probeErrorCode);
				if (canRetry && !systemic && probeErrorCode !== 'cancelled') {
					return 'retry';
				}

				const message = error instanceof Error ? error.message : 'Media file could not be probed.';
				const firstSystemicFailure = systemic && systemicProbeFailure === null;
				if (systemic) {
					systemicProbeFailure = { code: probeErrorCode, message };
				}
				if (!systemic || firstSystemicFailure) {
					issues.push({
						path: systemic ? null : relativePath,
						code: `media_${probeErrorCode.replaceAll('-', '_')}`,
						message,
						severity: systemic ? 'error' : 'warning',
					});
				}
			}
		}
		else {
			probeErrorCode = 'executable-unavailable';
			issues.push({
				path: relativePath,
				code: 'media_executable_unavailable',
				message: 'Media file could not be measured because ffprobe is unavailable.',
				severity: 'warning',
			});
		}

		// Parse bounded descriptive metadata without trusting it for playback properties.
		const nfo = await readNfo(file, scanRoot, logicalStem, library.typeKey, signal);
		if (nfo.issue) {
			issues.push({ ...nfo.issue, path: normalizeRelative(scanRoot, nfo.issue.path ?? file) });
		}
		if (nfo.parsed?.truncatedFields.length) {
			issues.push({
				path: normalizeRelative(scanRoot, nfo.path ?? file),
				code: 'metadata_truncated',
				message: `Metadata exceeded documented limits: ${nfo.parsed.truncatedFields.join(', ')}.`,
				severity: 'warning',
			});
		}
		if (nfo.parsed?.invalidFields.length) {
			issues.push({
				path: normalizeRelative(scanRoot, nfo.path ?? file),
				code: 'metadata_invalid',
				message: `Invalid metadata values were ignored: ${nfo.parsed.invalidFields.join(', ')}.`,
				severity: 'warning',
			});
		}
		const probeTags = probeResult?.tags ?? {};
		const musicVideoTitle = library.typeKey === 'music-videos' ? probeTags.title : undefined;
		const title = nfo.parsed?.title ?? musicVideoTitle ?? filename.title;
		const taggedYear = library.typeKey === 'music-videos'
			? taggedNumber(probeTags.date ?? probeTags.year)
			: null;
		const year = nfo.parsed?.year ?? taggedYear ?? filename.year;
		const stem = file.slice(0, -path.extname(file).length);
		const nfoArtwork = await referencedArtwork(
			scanRoot,
			nfo.path,
			nfo.parsed?.primaryArtworkPaths ?? [],
			signal,
		);

		// Resolve conventional artwork names for the item.
		const artwork = nfoArtwork ?? await existingArtwork(
			[
				`${logicalStem}-poster`,
				`${logicalStem}-cover`,
				`${logicalStem}-default`,
				...(library.typeKey === 'shows' ? [] : [`${logicalStem}-movie`]),
				logicalStem,
				`${stem}-poster`,
				`${stem}-thumb`,
				path.join(path.dirname(file), 'poster'),
				path.join(path.dirname(file), 'folder'),
				path.join(path.dirname(file), 'cover'),
				path.join(path.dirname(file), 'default'),
				...(library.typeKey === 'movies'
					? [path.join(path.dirname(file), 'movie')]
					: []),
				path.join(path.dirname(file), 'thumb'),
				path.join(path.dirname(file), 'fanart'),
			],
			signal,
		);

		let groupId: string | null = null;
		const seasonNumber = nfo.parsed?.seasonNumber ?? filename.seasonNumber;
		const episodeNumber = nfo.parsed?.episodeNumber ?? filename.episodeNumber;
		const episodeEndNumber = filename.episodeEndNumber;

		// Build show and season hierarchy records around episode media.
		if (library.typeKey === 'shows') {
			const parts = relativePath.split('/');
			const showFolder = parts.length > 1 ? parts[0]! : path.basename(path.dirname(file));
			const showDirectory = path.join(scanRoot, showFolder);
			if (!groupNfoCache.has(showDirectory)) {
				groupNfoCache.set(
					showDirectory,
					await readGroupNfo(path.join(showDirectory, 'tvshow.nfo'), scanRoot, issues, signal),
				);
			}
			const showNfo = groupNfoCache.get(showDirectory) ?? null;
			const showFilename = parseCollectionFolder(showFolder);
			const showKey = `show:${showFolder}`;
			const showId = deterministicId(library.id, showKey);
			if (!groupsByKey.has(showKey)) {
				const referencedShowArt = await referencedArtwork(
					scanRoot,
					path.join(showDirectory, 'tvshow.nfo'),
					showNfo?.primaryArtworkPaths ?? [],
					signal,
				);
				const showNameStem = path.join(showDirectory, showFolder);
				const showArt = referencedShowArt ?? await existingArtwork(
					[
						showNameStem,
						`${showNameStem}-poster`,
						`${showNameStem}-cover`,
						`${showNameStem}-default`,
						`${showNameStem}-show`,
						path.join(showDirectory, 'poster'),
						path.join(showDirectory, 'folder'),
						path.join(showDirectory, 'cover'),
						path.join(showDirectory, 'default'),
						path.join(showDirectory, 'show'),
						path.join(showDirectory, 'fanart'),
					],
					signal,
				);
				const showArtworkFingerprint = await artworkFingerprint(scanRoot, showArt);
				groupsByKey.set(showKey, {
					id: showId,
					stableKey: showKey,
					sourceKey: showKey,
					parentId: null,
					kind: 'show',
					title: showNfo?.title ?? showFilename.title,
					sortTitle: catalogSortTitle(
						showNfo?.title ?? showFilename.title,
						showNfo?.sortTitle,
					),
					year: showNfo?.year ?? showFilename.year,
					plot: showNfo?.plot ?? null,
					metadata: {
						...(showNfo?.metadata ?? {}),
						externalIds: mergedExternalIds(
							showNfo?.externalIds ?? [],
							showFilename.externalIds,
						),
						...(showArtworkFingerprint ? { artworkFingerprint: showArtworkFingerprint } : {}),
					},
					artworkRelativePath: showArt ? normalizeRelative(scanRoot, showArt) : null,
				});
			}
			const seasonKey = `${showKey}:season:${seasonNumber ?? 0}`;
			groupId = deterministicId(library.id, seasonKey);
			if (!groupsByKey.has(seasonKey)) {
				const seasonDirectory = path.dirname(file);
				const seasonNfoPath = path.join(seasonDirectory, 'season.nfo');
				if (!groupNfoCache.has(seasonNfoPath)) {
					groupNfoCache.set(
						seasonNfoPath,
						await readGroupNfo(seasonNfoPath, scanRoot, issues, signal),
					);
				}
				const seasonNfo = groupNfoCache.get(seasonNfoPath) ?? null;
				const referencedSeasonArt = await referencedArtwork(
					scanRoot,
					seasonNfoPath,
					seasonNfo?.primaryArtworkPaths ?? [],
					signal,
				);
				const seasonArt = referencedSeasonArt ?? await existingArtwork(
					[
						path.join(showDirectory, `season${String(seasonNumber ?? 0).padStart(2, '0')}-poster`),
						path.join(seasonDirectory, 'poster'),
						path.join(seasonDirectory, 'folder'),
						path.join(seasonDirectory, 'cover'),
						path.join(seasonDirectory, 'default'),
					],
					signal,
				);
				const seasonArtworkFingerprint = await artworkFingerprint(scanRoot, seasonArt);
				groupsByKey.set(seasonKey, {
					id: groupId,
					stableKey: seasonKey,
					sourceKey: seasonKey,
					parentId: showId,
					kind: 'season',
					title: seasonNfo?.title
						?? (seasonNumber === null || seasonNumber === 0 ? 'Specials' : `Season ${seasonNumber}`),
					sortTitle: seasonNfo?.sortTitle ?? String(seasonNumber ?? 0).padStart(5, '0'),
					year: seasonNfo?.year ?? null,
					plot: seasonNfo?.plot ?? null,
					metadata: {
						...(seasonNfo?.metadata ?? {}),
						seasonNumber,
						externalIds: seasonNfo?.externalIds ?? [],
						...(seasonArtworkFingerprint ? { artworkFingerprint: seasonArtworkFingerprint } : {}),
					},
					artworkRelativePath: seasonArt ? normalizeRelative(scanRoot, seasonArt) : null,
				});
			}
		}
		else if (library.typeKey === 'music-videos') {
			const pathParts = relativePath.split('/');
			if (pathParts.length >= 3) {
				const artistFolder = pathParts[0]!;
				const albumFolder = pathParts[1]!;
				const artistKey = `artist:${artistFolder}`;
				const artistId = deterministicId(library.id, artistKey);
				if (!groupsByKey.has(artistKey)) {
					const artistDirectory = path.join(scanRoot, artistFolder);
					const artistArt = await existingArtwork([
						path.join(artistDirectory, 'folder'),
						path.join(artistDirectory, 'poster'),
						path.join(artistDirectory, 'cover'),
						path.join(artistDirectory, 'default'),
					], signal);
					const artistArtworkFingerprint = await artworkFingerprint(scanRoot, artistArt);
					groupsByKey.set(artistKey, {
						id: artistId,
						stableKey: artistKey,
						sourceKey: artistKey,
						parentId: null,
						kind: 'artist',
						title: artistFolder,
						sortTitle: catalogSortTitle(artistFolder),
						year: null,
						plot: null,
						metadata: artistArtworkFingerprint
							? { artworkFingerprint: artistArtworkFingerprint }
							: {},
						artworkRelativePath: artistArt ? normalizeRelative(scanRoot, artistArt) : null,
					});
				}

				const albumDirectory = path.join(scanRoot, artistFolder, albumFolder);
				const albumNfoPath = path.join(albumDirectory, `${artistFolder} - ${albumFolder}.nfo`);
				if (!groupNfoCache.has(albumNfoPath)) {
					groupNfoCache.set(
						albumNfoPath,
						await readGroupNfo(albumNfoPath, scanRoot, issues, signal),
					);
				}
				const albumNfo = groupNfoCache.get(albumNfoPath) ?? null;
				const albumKey = `${artistKey}:album:${albumFolder}`;
				groupId = deterministicId(library.id, albumKey);
				if (!groupsByKey.has(albumKey)) {
					const referencedAlbumArt = await referencedArtwork(
						scanRoot,
						albumNfoPath,
						albumNfo?.primaryArtworkPaths ?? [],
						signal,
					);
					const albumArt = referencedAlbumArt ?? await existingArtwork([
						path.join(albumDirectory, 'folder'),
						path.join(albumDirectory, 'poster'),
						path.join(albumDirectory, 'cover'),
						path.join(albumDirectory, 'default'),
					], signal);
					const albumArtworkFingerprint = await artworkFingerprint(scanRoot, albumArt);
					groupsByKey.set(albumKey, {
						id: groupId,
						stableKey: albumKey,
						sourceKey: albumKey,
						parentId: artistId,
						kind: 'album',
						title: albumNfo?.title ?? probeTags.album ?? albumFolder,
						sortTitle: catalogSortTitle(
							albumNfo?.title ?? probeTags.album ?? albumFolder,
							albumNfo?.sortTitle,
						),
						year: albumNfo?.year ?? taggedYear,
						plot: albumNfo?.plot ?? null,
						metadata: {
							...(albumNfo?.metadata ?? {}),
							externalIds: albumNfo?.externalIds ?? [],
							...(albumArtworkFingerprint ? { artworkFingerprint: albumArtworkFingerprint } : {}),
						},
						artworkRelativePath: albumArt ? normalizeRelative(scanRoot, albumArt) : null,
					});
				}
			}
		}

		// Normalize the final item, metadata facets, artwork fingerprint, and playback path.
		const kind
			= library.typeKey === 'shows'
				? 'episode'
				: library.typeKey === 'music-videos'
					? 'music-video'
					: library.typeKey === 'movies'
						? 'movie'
						: 'other';
		const itemArtworkFingerprint = await artworkFingerprint(scanRoot, artwork);
		const genres = normalizeGenres([
			...(nfo.parsed?.genres ?? []),
			...(library.typeKey === 'music-videos'
				? (probeTags.genre ?? '').split(/\s*;\s*/).filter(Boolean)
				: []),
		]);
		const people = normalizePeople(
			nfo.parsed?.directors ?? [],
			nfo.parsed?.actors ?? [],
		);
		const locatedSidecars = await sidecarsFor(file, filename);
		const partNumber = filename.part?.number ?? 1;
		const relativeMediaPath = relativePath;
		const embeddedSubtitles = embeddedSubtitleTracks(probeResult, partNumber, relativeMediaPath);
		const partSidecars = locatedSidecars
			.filter((entry) => entry.track.partNumber === partNumber)
			.map((entry) => entry.track);
		const logicalSubtitles = locatedSidecars
			.filter((entry) => entry.track.partNumber === null)
			.map((entry) => entry.track);
		const artistTag = probeTags.artist ?? probeTags.album_artist;
		const nfoArtists = Array.isArray(nfo.parsed?.metadata.artists)
			? nfo.parsed.metadata.artists as string[]
			: [];
		const taggedArtistNames = taggedArtists(artistTag);
		const artists = library.typeKey === 'music-videos'
			? (nfoArtists.length > 0
				? nfoArtists
				: taggedArtistNames.length > 0
					? taggedArtistNames
					: relativePath.includes('/') ? [relativePath.split('/')[0]!] : [])
			: [];
		const discNumber = nfo.parsed?.discNumber ?? taggedNumber(probeTags.disc) ?? filename.discNumber;
		const trackNumber = typeof nfo.parsed?.metadata.track === 'number'
			? nfo.parsed.metadata.track
			: taggedNumber(probeTags.track) ?? filename.trackNumber;
		const externalIds = mergedExternalIds(nfo.parsed?.externalIds ?? [], filename.externalIds);
		const sortTitle = catalogSortTitle(title, nfo.parsed?.sortTitle);
		const itemPart: MediaPart = {
			number: partNumber,
			kind: filename.part?.kind ?? null,
			relativePath,
			playbackPath: playbackPath(library, relativePath),
			durationSeconds: probeResult ? probeResult.durationMilliseconds / 1_000 : null,
			subtitleTracks: [...embeddedSubtitles, ...partSidecars],
		};
		items.push({
			id: deterministicId(library.id, relativePath),
			aliasIds: [],
			groupId,
			stableKey: nfo.parsed?.uniqueId ?? relativePath,
			kind,
			title,
			sortTitle,
			relativePath,
			playbackPath: playbackPath(library, relativePath),
			nfoRelativePath: nfo.path ? normalizeRelative(scanRoot, nfo.path) : null,
			plot: nfo.parsed?.plot ?? null,
			year,
			durationMilliseconds: probeResult?.durationMilliseconds ?? null,
			probeFingerprint,
			probeStatus: probeResult ? 'complete' : 'failed',
			probeUpdatedAt,
			probeErrorCode,
			technicalMetadata: probeResult
				? {
					fileSizeBytes: probeResult.fileSizeBytes,
					container: probeResult.container,
					streams: probeResult.streams,
					resolution: probeResult.resolution,
					tags: probeResult.tags,
				}
				: { fileSizeBytes: Number(mediaInfo.size) },
			seasonNumber,
			episodeNumber,
			episodeEndNumber,
			edition: filename.edition,
			externalIds,
			trackNumber,
			discNumber,
			artists,
			multipartStatus: 'none',
			parts: [itemPart],
			subtitleTracks: logicalSubtitles,
			metadataStatus: nfo.status,
			metadata: {
				...(nfo.parsed?.metadata ?? {}),
				externalIds,
				artists,
				album: nfo.parsed?.metadata.album ?? probeTags.album
					?? (library.typeKey !== 'music-videos' || relativePath.split('/').length >= 3 ? relativePath.split('/')[1] ?? null : null),
				track: trackNumber,
				disc: discNumber,
				...(itemArtworkFingerprint ? { artworkFingerprint: itemArtworkFingerprint } : {}),
			},
			artworkRelativePath: artwork ? normalizeRelative(scanRoot, artwork) : null,
			fingerprint: await fingerprint(
				scanRoot,
				[file, nfo.path, artwork, ...locatedSidecars.flatMap((entry) => entry.absolutePaths)],
				file,
				mediaInfo,
				signal,
				`${probeFingerprint}:${probeResult?.durationMilliseconds ?? probeErrorCode ?? 'failed'}`,
			),
			fileModifiedAt: mediaInfo.mtime.toISOString(),
			titleBucket: titleBucket(sortTitle),
			genres,
			people,
		});
		return 'complete';
	}

	// Complete the inventory before retrying failed probes, without inflating file progress.
	await runScanQueue(walked.files, {
		concurrency: options.discoveryConcurrency ?? 1,
		signal,
		onProgress: options.onProgress,
		processFile: async (file, canRetry) => {
			try {
				throwIfCancelled(signal);
				return await discoverFile(file, canRetry);
			}
			catch (error) {
				if (signal?.aborted) {
					throw error;
				}

				traversalComplete = false;
				const missingDuringScan
					= (error as NodeJS.ErrnoException).code === 'ENOENT'
						|| (error instanceof SourceFileError
							&& (error.reason === 'missing' || error.reason === 'changed'));
				issues.push({
					path: normalizeRelative(scanRoot, file),
					code: missingDuringScan ? 'media_changed_during_scan' : 'media_unreadable',
					message: internalErrorMessage(error),
					severity: missingDuringScan ? 'warning' : 'error',
				});
				return 'complete';
			}
		},
	});
	options.onProgress?.({
		phase: 'finalizing',
		processedCount: walked.files.length,
		totalCount: walked.files.length,
	});

	// Complete music hierarchy for files outside the documented artist/album folder layout.
	if (library.typeKey === 'music-videos') {
		groupLooseMusicVideos(library.id, groupsByKey, items);
		inheritMusicArtistArtwork([...groupsByKey.values()], items);
	}

	// Collapse numbered physical files into one logical, schedulable catalog item.
	collapseMultipartItems(items, issues, library.typeKey);
	for (const item of items) {
		item.fingerprint = stableJsonFingerprint({
			sourceFingerprint: item.fingerprint,
			normalizedMetadata: normalizedItemMetadata(item),
		});
	}
	items.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
	issues.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? '') || left.code.localeCompare(right.code));

	// Derive show year ranges from the episodes grouped beneath each show.
	if (library.typeKey === 'shows') {
		const showBySeason = new Map(
			[...groupsByKey.values()]
				.filter((group) => group.kind === 'season' && group.parentId)
				.map((group) => [group.id, group.parentId!]),
		);
		const yearsByShow = new Map<string, number[]>();
		for (const item of items) {
			const showId = item.groupId ? showBySeason.get(item.groupId) : undefined;
			if (!showId || item.year === null) {
				continue;
			}

			const years = yearsByShow.get(showId) ?? [];
			years.push(item.year);
			yearsByShow.set(showId, years);
		}
		for (const group of groupsByKey.values()) {
			if (group.kind !== 'show') {
				continue;
			}

			const years = yearsByShow.get(group.id) ?? [];
			if (group.year !== null) {
				years.push(group.year);
			}
			if (years.length === 0) {
				continue;
			}

			group.year = Math.min(...years);
			group.metadata = { ...group.metadata, yearEnd: Math.max(...years) };
		}
	}

	// Detect provider IDs reused by otherwise distinct show folders.
	const externalIdPaths = new Map<string, { provider: string; externalId: string; paths: Set<string> }>();
	for (const group of groupsByKey.values()) {
		if (group.kind !== 'show') {
			continue;
		}

		const ids = Array.isArray(group.metadata.externalIds)
			? group.metadata.externalIds as ParsedNfo['externalIds']
			: [];
		for (const externalId of ids) {
			const key = `${externalId.provider.toLocaleLowerCase('en-US')}:${externalId.value.toLocaleLowerCase('en-US')}`;
			const observed = externalIdPaths.get(key) ?? {
				provider: externalId.provider,
				externalId: externalId.value,
				paths: new Set<string>(),
			};
			observed.paths.add((group.sourceKey ?? group.stableKey).slice('show:'.length));
			externalIdPaths.set(key, observed);
		}
	}
	const conflicts: CatalogConflictObservation[] = [];
	for (const [key, observed] of externalIdPaths) {
		if (observed.paths.size < 2) {
			continue;
		}

		const paths = [...observed.paths].sort((left, right) => left.localeCompare(right));
		conflicts.push({
			conflictKey: `show-external-id:${key}`,
			kind: 'show-external-id',
			provider: observed.provider,
			externalId: observed.externalId,
			paths,
			message: `${observed.provider} ID ${observed.externalId} is present in multiple show folders.`,
		});
		issues.push({
			path: paths[0] ?? null,
			code: 'show_external_id_conflict',
			message: `${observed.provider} ID ${observed.externalId} is shared by ${paths.length} show folders; the folders remain separate.`,
			severity: 'warning',
		});
	}

	// Recheck source identity so root replacement during the scan cannot confirm removals.
	const completedIdentity = await identifyOnDiskSource(library.sourceConfig.scanRoot, signal);
	if (
		completedIdentity.sourceKey !== sourceIdentity.sourceKey
		|| completedIdentity.details.device !== sourceIdentity.details.device
		|| completedIdentity.details.inode !== sourceIdentity.details.inode
	) {
		traversalComplete = false;
		issues.push({
			path: null,
			code: 'source_identity_changed_during_scan',
			message: 'The source root changed while it was being scanned; no removals were confirmed.',
			severity: 'error',
		});
	}

	// Return stable ordering for deterministic reconciliation and diagnostics.
	return {
		groups: [...groupsByKey.values()].sort((left, right) =>
			left.stableKey.localeCompare(right.stableKey)),
		items,
		issues,
		traversalComplete,
		sourceIdentity,
		conflicts,
	};
}
