import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {
	DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS,
	MAX_EXPLICIT_MEDIA_ITEMS,
} from '@moirai/shared';

/** Repository root used to resolve development-friendly relative defaults. */
const projectRoot = path.resolve(import.meta.dirname, '../../..');

/** Pinned ErsatzTV Next checkout included for native development. */
export const bundledNextRoot = path.join(projectRoot, 'vendor', 'ersatztv-next');

/** Validated runtime paths, limits, network settings, and scheduling options. */
export interface AppConfig {
	host: string;
	port: number;
	trustedProxies: string[];
	publicUrl: string;
	managementUrl: string;
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
	maxExplicitMediaItems: number;
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
	logto: LogtoConfig | null;
}

/** Logto traditional-web application settings used by the OIDC provider adapter. */
export interface LogtoConfig {
	endpoint: string;
	appId: string;
	appSecret: string;
}

/** Public URL plus whether remote clients can reach the configured host. */
export type PublicUrlStatus = 'configured' | 'unreachable-default';

/** Symbolic proxy-address groups accepted by Fastify's proxy address resolver. */
const TRUSTED_PROXY_GROUPS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** Resolve a configured relative path from the project root. */
function resolveFromProjectRoot(value: string): string {
	return path.resolve(projectRoot, value);
}

/** Parse a positive megabyte setting and convert it to bytes. */
function megabytesFromEnvironment(value: string | undefined, fallback: number): number {
	const parsed = Number(value ?? fallback);
	const megabytes = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
	const bytes = Math.round(megabytes * 1024 * 1024);
	return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : fallback * 1024 * 1024;
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

/** Return whether a literal hostname identifies localhost or an IP in the loopback ranges. */
export function isLoopbackHostname(value: string): boolean {
	const hostname = value.toLowerCase().replace(/^\[|\]$/gu, '');
	if (hostname === 'localhost' || hostname === '::1') {
		return true;
	}

	return isIP(hostname) === 4 && hostname.split('.', 1)[0] === '127';
}

/** Parse explicit proxy IPs, CIDRs, or named local-network groups used to trust forwarded clients. */
export function resolveTrustedProxies(value?: string): string[] {
	if (!value?.trim()) {
		return [];
	}

	const proxies = value.split(',').map((entry) => entry.trim()).filter(Boolean);
	for (const proxy of proxies) {
		if (TRUSTED_PROXY_GROUPS.has(proxy)) {
			continue;
		}

		const [address, prefix, ...remainder] = proxy.split('/');
		const family = isIP(address ?? '');
		const maximumPrefix = family === 4 ? 32 : 128;
		if (
			family === 0
			|| remainder.length > 0
			|| (prefix !== undefined
				&& (!/^\d+$/u.test(prefix) || Number(prefix) > maximumPrefix))
		) {
			throw new Error(
				'MOIRAI_TRUST_PROXY must contain comma-separated IP addresses, CIDRs, or '
				+ 'loopback, linklocal, and uniquelocal groups',
			);
		}
	}

	return [...new Set(proxies)];
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

/** Parse one HTTP(S) origin without permitting URL components that alter request routing. */
function resolveHttpOrigin(candidate: string, name: string): string {
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
			`${name} must be an HTTP(S) origin without credentials, a path, a query, or a fragment`,
		);
	}

	return parsed.origin;
}

/** Normalize the public HTTP(S) origin used in generated client URLs. */
export function resolvePublicUrl(value: string | undefined, port: number): string {
	return resolveHttpOrigin(value?.trim() || `http://127.0.0.1:${port}`, 'MOIRAI_PUBLIC_URL');
}

/**
 * Normalize the browser UI origin while retaining the public origin's cookie-compatible scheme and
 * hostname. Development may use a distinct port for Vite.
 */
export function resolveManagementUrl(value: string | undefined, publicUrl: string): string {
	const resolved = resolveHttpOrigin(value?.trim() || publicUrl, 'MOIRAI_MANAGEMENT_URL');
	const management = new URL(resolved);
	const publicOrigin = new URL(publicUrl);
	if (
		management.protocol !== publicOrigin.protocol
		|| management.hostname !== publicOrigin.hostname
	) {
		throw new Error(
			'MOIRAI_MANAGEMENT_URL must use the same scheme and hostname as MOIRAI_PUBLIC_URL',
		);
	}

	return resolved;
}

/** Flag URL hosts that cannot be reached by a separate IPTV client. */
export function publicUrlStatus(value: string): PublicUrlStatus {
	const hostname = new URL(value).hostname.toLowerCase();
	if (
		isLoopbackHostname(hostname)
		|| hostname === '0.0.0.0'
	) {
		return 'unreachable-default';
	}

	return 'configured';
}

/** Validate an optional all-or-nothing Logto OIDC configuration. */
function resolveLogtoConfig(overrides?: LogtoConfig | null): LogtoConfig | null {
	if (overrides !== undefined) {
		return overrides;
	}

	const endpoint = process.env.MOIRAI_LOGTO_ENDPOINT?.trim();
	const appId = process.env.MOIRAI_LOGTO_APP_ID?.trim();
	const appSecret = process.env.MOIRAI_LOGTO_APP_SECRET?.trim();
	if (!endpoint && !appId && !appSecret) {
		return null;
	}
	if (!endpoint || !appId || !appSecret) {
		throw new Error(
			'MOIRAI_LOGTO_ENDPOINT, MOIRAI_LOGTO_APP_ID, and MOIRAI_LOGTO_APP_SECRET must be configured together',
		);
	}

	const parsed = new URL(endpoint);
	const isLoopback = isLoopbackHostname(parsed.hostname);
	if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback))
		|| parsed.username
		|| parsed.password
		|| parsed.pathname !== '/'
		|| parsed.search
		|| parsed.hash) {
		throw new Error(
			'MOIRAI_LOGTO_ENDPOINT must be an HTTPS origin or loopback HTTP origin without credentials, path, query, or fragment',
		);
	}

	return { endpoint: parsed.href.replace(/\/+$/u, ''), appId, appSecret };
}

/** Read environment settings and explicit overrides into validated runtime configuration. */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	const dataDir
		= overrides.dataDir ?? resolveFromProjectRoot(process.env.MOIRAI_DATA_DIR ?? './data');
	const port = overrides.port ?? Number(process.env.MOIRAI_PORT ?? 3000);
	const publicUrl = resolvePublicUrl(overrides.publicUrl ?? process.env.MOIRAI_PUBLIC_URL, port);
	const managementUrl = resolveManagementUrl(
		overrides.managementUrl ?? process.env.MOIRAI_MANAGEMENT_URL,
		publicUrl,
	);
	return {
		host: overrides.host ?? process.env.MOIRAI_HOST ?? '127.0.0.1',
		port,
		trustedProxies: overrides.trustedProxies
			?? resolveTrustedProxies(process.env.MOIRAI_TRUST_PROXY),
		publicUrl,
		managementUrl,
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
		maxExplicitMediaItems: overrides.maxExplicitMediaItems
			?? integerFromEnvironment(
				process.env.MOIRAI_MAX_EXPLICIT_MEDIA_ITEMS,
				DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS,
				1,
				MAX_EXPLICIT_MEDIA_ITEMS,
				'MOIRAI_MAX_EXPLICIT_MEDIA_ITEMS',
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
		logto: resolveLogtoConfig(overrides.logto),
	};
}
