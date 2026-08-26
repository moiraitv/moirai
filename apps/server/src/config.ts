import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Repository root used to resolve development-friendly relative defaults. */
const projectRoot = path.resolve(import.meta.dirname, '../../..');

/** Pinned ErsatzTV Next checkout included for native development. */
export const bundledNextRoot = path.join(projectRoot, 'vendor', 'ersatztv-next');

/** Validated runtime paths, limits, network settings, and scheduling options. */
export interface AppConfig {
	host: string;
	port: number;
	publicUrl: string;
	logLevel: string;
	logDir: string;
	logRetentionDays: number;
	logMaxBytes: number;
	logFileMaxBytes: number;
	scanHistoryRetentionDays: number;
	scanHistoryMaxPerLibrary: number;
	dataDir: string;
	databasePath: string;
	artworkCacheDir: string;
	artworkCacheMaxBytes: number;
	artworkCacheMaxEntryBytes: number;
	artworkTransformConcurrency: number;
	ffprobePath: string;
	mediaProbeConcurrency: number;
	mediaProbeTimeoutMs: number;
	schedulingWorkerCount: number;
	schedulingWorkerQueueLimit: number;
	scanCancellationGraceMs: number;
	shutdownDeadlineMs: number;
	channelLogoDir: string;
	playbackEnginePath: string;
	playbackStreamDir: string;
	playbackPlayoutDir: string;
	playbackSyncIntervalSeconds: number;
	playbackReadyTimeoutMs: number;
	playbackStopGraceMs: number;
	webDistDir: string;
	migrationsDir: string;
	timeZone: string;
}

/** Public URL plus whether remote clients can reach the configured host. */
export type PublicUrlStatus = 'configured' | 'unreachable-default';

/** Resolve a configured relative path from the project root. */
function resolveFromProjectRoot(value: string): string {
	return path.resolve(projectRoot, value);
}

/** Parse a positive megabyte setting and convert it to bytes. */
function megabytesFromEnvironment(value: string | undefined, fallback: number): number {
	const parsed = Number(value ?? fallback);
	return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 1024 * 1024;
}

/** Parse and bound an integer environment setting. */
function integerFromEnvironment(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	const parsed = Number(value ?? fallback);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
	}

	return parsed;
}

/** Return explicit and pinned checkouts that may contain a development engine. */
export function resolveNextDevelopmentRoots(value?: string): string[] {
	const roots = [value?.trim(), bundledNextRoot].filter(
		(candidate): candidate is string => Boolean(candidate),
	);
	return [...new Set(roots.map((root) => path.resolve(root)))];
}

/** Resolve the standalone playback engine with explicit and pinned development fallbacks. */
export function resolvePlaybackEnginePath(value?: string): string {
	if (value?.trim()) {
		return value.trim();
	}

	const executable = process.platform === 'win32' ? 'ersatztv-channel.exe' : 'ersatztv-channel';
	for (const root of resolveNextDevelopmentRoots(process.env.ETV_NEXT_DIR)) {
		for (const profile of ['release', 'debug']) {
			const candidate = path.resolve(root, 'target', profile, executable);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return executable;
}

/** Validate a configured IANA time zone or use the machine time zone. */
export function resolveTimeZone(value?: string): string {
	const candidate = value?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format();
	}
	catch {
		throw new Error(`MOIRAI_TIME_ZONE must be a valid IANA time zone; received "${candidate}"`);
	}
	return candidate;
}

/** Normalize the public HTTP(S) origin used in generated client URLs. */
export function resolvePublicUrl(value: string | undefined, port: number): string {
	const candidate = value?.trim() || `http://127.0.0.1:${port}`;
	const parsed = new URL(candidate);
	if (
		!['http:', 'https:'].includes(parsed.protocol)
		|| parsed.username
		|| parsed.password
		|| parsed.pathname !== '/'
		|| parsed.search
		|| parsed.hash
	) {
		throw new Error(
			'MOIRAI_PUBLIC_URL must be an HTTP(S) origin without credentials, a path, a query, or a fragment',
		);
	}

	return parsed.origin;
}

/** Flag URL hosts that cannot be reached by a separate IPTV client. */
export function publicUrlStatus(value: string): PublicUrlStatus {
	const hostname = new URL(value).hostname.toLowerCase();
	if (
		hostname === 'localhost'
		|| hostname === '::1'
		|| hostname === '0.0.0.0'
		|| hostname.startsWith('127.')
	) {
		return 'unreachable-default';
	}

	return 'configured';
}

/** Read environment settings and explicit overrides into validated runtime configuration. */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	const dataDir
		= overrides.dataDir ?? resolveFromProjectRoot(process.env.MOIRAI_DATA_DIR ?? './data');
	const port = overrides.port ?? Number(process.env.MOIRAI_PORT ?? 3000);
	return {
		host: overrides.host ?? process.env.MOIRAI_HOST ?? '127.0.0.1',
		port,
		publicUrl: resolvePublicUrl(overrides.publicUrl ?? process.env.MOIRAI_PUBLIC_URL, port),
		logLevel: overrides.logLevel ?? process.env.MOIRAI_LOG_LEVEL ?? 'info',
		dataDir,
		logDir: overrides.logDir
			?? (process.env.MOIRAI_LOG_DIR
				? resolveFromProjectRoot(process.env.MOIRAI_LOG_DIR)
				: path.join(dataDir, 'logs')),
		logRetentionDays: overrides.logRetentionDays
			?? integerFromEnvironment(
				process.env.MOIRAI_LOG_RETENTION_DAYS,
				14,
				1,
				3650,
				'MOIRAI_LOG_RETENTION_DAYS',
			),
		logMaxBytes: overrides.logMaxBytes
			?? megabytesFromEnvironment(process.env.MOIRAI_LOG_MAX_MB, 200),
		logFileMaxBytes: overrides.logFileMaxBytes
			?? megabytesFromEnvironment(process.env.MOIRAI_LOG_FILE_MAX_MB, 10),
		scanHistoryRetentionDays: overrides.scanHistoryRetentionDays
			?? integerFromEnvironment(
				process.env.MOIRAI_SCAN_HISTORY_RETENTION_DAYS,
				30,
				1,
				3650,
				'MOIRAI_SCAN_HISTORY_RETENTION_DAYS',
			),
		scanHistoryMaxPerLibrary: overrides.scanHistoryMaxPerLibrary
			?? integerFromEnvironment(
				process.env.MOIRAI_SCAN_HISTORY_MAX_PER_LIBRARY,
				2_000,
				20,
				100_000,
				'MOIRAI_SCAN_HISTORY_MAX_PER_LIBRARY',
			),
		databasePath: overrides.databasePath ?? path.join(dataDir, 'moirai.sqlite'),
		artworkCacheDir: overrides.artworkCacheDir ?? path.join(dataDir, 'artwork-cache'),
		artworkCacheMaxBytes: overrides.artworkCacheMaxBytes
			?? megabytesFromEnvironment(process.env.MOIRAI_ARTWORK_CACHE_MAX_MB, 2048),
		artworkCacheMaxEntryBytes: overrides.artworkCacheMaxEntryBytes
			?? megabytesFromEnvironment(process.env.MOIRAI_ARTWORK_CACHE_MAX_ENTRY_MB, 25),
		artworkTransformConcurrency: overrides.artworkTransformConcurrency
			?? integerFromEnvironment(
				process.env.MOIRAI_ARTWORK_TRANSFORM_CONCURRENCY,
				4,
				1,
				16,
				'MOIRAI_ARTWORK_TRANSFORM_CONCURRENCY',
			),
		ffprobePath: overrides.ffprobePath
			?? (process.env.MOIRAI_FFPROBE_PATH?.trim() || 'ffprobe'),
		mediaProbeConcurrency: overrides.mediaProbeConcurrency
			?? integerFromEnvironment(
				process.env.MOIRAI_MEDIA_PROBE_CONCURRENCY,
				2,
				1,
				16,
				'MOIRAI_MEDIA_PROBE_CONCURRENCY',
			),
		mediaProbeTimeoutMs: overrides.mediaProbeTimeoutMs
			?? integerFromEnvironment(
				process.env.MOIRAI_MEDIA_PROBE_TIMEOUT_MS,
				15_000,
				1_000,
				120_000,
				'MOIRAI_MEDIA_PROBE_TIMEOUT_MS',
			),
		schedulingWorkerCount: overrides.schedulingWorkerCount
			?? integerFromEnvironment(
				process.env.MOIRAI_SCHEDULING_WORKERS,
				2,
				0,
				4,
				'MOIRAI_SCHEDULING_WORKERS',
			),
		schedulingWorkerQueueLimit: overrides.schedulingWorkerQueueLimit
			?? integerFromEnvironment(
				process.env.MOIRAI_SCHEDULING_WORKER_QUEUE,
				32,
				1,
				256,
				'MOIRAI_SCHEDULING_WORKER_QUEUE',
			),
		scanCancellationGraceMs: overrides.scanCancellationGraceMs
			?? integerFromEnvironment(
				process.env.MOIRAI_SCAN_CANCEL_GRACE_MS,
				5_000,
				100,
				60_000,
				'MOIRAI_SCAN_CANCEL_GRACE_MS',
			),
		shutdownDeadlineMs: overrides.shutdownDeadlineMs
			?? integerFromEnvironment(
				process.env.MOIRAI_SHUTDOWN_DEADLINE_MS,
				10_000,
				1_000,
				120_000,
				'MOIRAI_SHUTDOWN_DEADLINE_MS',
			),
		channelLogoDir: overrides.channelLogoDir ?? path.join(dataDir, 'channel-logos'),
		playbackEnginePath: overrides.playbackEnginePath
			?? resolvePlaybackEnginePath(process.env.MOIRAI_ETV_CHANNEL_PATH),
		playbackStreamDir: overrides.playbackStreamDir
			?? path.resolve(dataDir, process.env.MOIRAI_PLAYBACK_STREAM_DIR ?? 'streams'),
		playbackPlayoutDir: overrides.playbackPlayoutDir
			?? path.resolve(dataDir, process.env.MOIRAI_PLAYBACK_PLAYOUT_DIR ?? 'playout'),
		playbackSyncIntervalSeconds: overrides.playbackSyncIntervalSeconds
			?? integerFromEnvironment(
				process.env.MOIRAI_PLAYOUT_SYNC_INTERVAL_SECONDS,
				60,
				5,
				86_400,
				'MOIRAI_PLAYOUT_SYNC_INTERVAL_SECONDS',
			),
		playbackReadyTimeoutMs: overrides.playbackReadyTimeoutMs
			?? integerFromEnvironment(
				process.env.MOIRAI_PLAYBACK_READY_TIMEOUT_MS,
				30_000,
				1_000,
				120_000,
				'MOIRAI_PLAYBACK_READY_TIMEOUT_MS',
			),
		playbackStopGraceMs: overrides.playbackStopGraceMs
			?? integerFromEnvironment(
				process.env.MOIRAI_PLAYBACK_STOP_GRACE_MS,
				5_000,
				100,
				30_000,
				'MOIRAI_PLAYBACK_STOP_GRACE_MS',
			),
		webDistDir: overrides.webDistDir ?? resolveFromProjectRoot('apps/web/dist'),
		migrationsDir: overrides.migrationsDir ?? resolveFromProjectRoot('drizzle'),
		timeZone: resolveTimeZone(overrides.timeZone ?? process.env.MOIRAI_TIME_ZONE),
	};
}
