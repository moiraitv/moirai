import { z } from 'zod';
import type {
	ReconciliationStatus,
	SourceAvailability,
} from './availability.js';

export * from './scheduling.js';
export * from './normalization.js';
export * from './catalog.js';
export * from './availability.js';

/** Format a numeric count with the matching singular or plural noun. */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/** Built-in library categories advertised by the server. */
export const LIBRARY_TYPE_KEYS = ['movies', 'shows', 'music-videos', 'other'] as const;
/** Built-in media provider identifiers advertised by the server. */
export const SOURCE_TYPE_KEYS = ['on-disk'] as const;
/** Video suffixes treated as playable media by the on-disk provider. */
export const MEDIA_EXTENSIONS = [
	'.avi',
	'.m2ts',
	'.m4v',
	'.mkv',
	'.mov',
	'.mp4',
	'.mpeg',
	'.mpg',
	'.ts',
	'.webm',
] as const;
/** Maximum encoded size accepted for one managed playback fallback filler. */
export const FALLBACK_FILLER_MAX_BYTES = 512 * 1024 * 1024;
/** Minimum measured duration accepted for one managed playback fallback filler. */
export const FALLBACK_FILLER_MIN_DURATION_MILLISECONDS = 60_000;
/** Conclusive source observations required before an ordinary missing item is deleted. */
export const REMOVAL_CONFIRMATION_OBSERVATIONS = 3;
/** Minimum spacing between conclusive observations that confirm a removal. */
export const REMOVAL_CONFIRMATION_INTERVAL_MINUTES = 30;
/** Default interval for full scans while live source monitoring is unavailable. */
export const DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES = 180;
/** Daily full-scan interval used as an integrity check while live monitoring is healthy. */
export const WATCHER_INTEGRITY_SCAN_INTERVAL_MINUTES = 1_440;
/** Missing-item count above which a large change requires operator reconciliation. */
export const MAJOR_REMOVAL_COUNT = 10;
/** Missing-item ratio above which a large change requires operator reconciliation. */
export const MAJOR_REMOVAL_RATIO = 0.2;

/** Shared wire contract for app capabilities. */
export interface AppCapabilities {
	libraryTypes: string[];
	sourceTypes: string[];
	mediaExtensions: string[];
	etvContractRevision: string;
	authentication: 'session';
	timeZone: string;
	publicUrl: string;
	publicUrlStatus: 'configured' | 'unreachable-default';
	maxExplicitMediaItems: number;
}

/** Authentication providers that can establish a full-access administrator session. */
export type AuthenticationProvider = 'local' | 'logto';

/** Safe administrator identity returned to the authenticated browser. */
export interface AuthenticationIdentity {
	id: string;
	provider: AuthenticationProvider;
	displayName: string;
	username: string | null;
}

/** Current initialization, login-method, and administrator-session state. */
export interface AuthenticationState {
	status: 'uninitialized' | 'anonymous' | 'authenticated';
	methods: {
		local: boolean;
		logto: boolean;
	};
	localUsername: string | null;
	identity: AuthenticationIdentity | null;
	csrfToken: string | null;
}

/** Validate the id contract at runtime. */
export const idSchema = z.uuid();
/** Validate the iso date contract at runtime. */
export const isoDateSchema = z.iso.datetime({ offset: true });
/** Validate the library type contract at runtime. */
export const libraryTypeSchema = z.string().trim().min(1).max(64);
/** Validate the source type contract at runtime. */
export const sourceTypeSchema = z.string().trim().min(1).max(64);

/** Validate the on disk source config contract at runtime. */
export const onDiskSourceConfigSchema = z.object({
	scanRoot: z.string().trim().min(1),
	playbackRoot: z.string().trim().min(1).nullable().default(null),
});

/** Validate the library create contract at runtime. */
export const libraryCreateSchema = z.object({
	name: z.string().trim().min(1).max(120),
	typeKey: libraryTypeSchema,
	sourceType: sourceTypeSchema,
	sourceConfig: onDiskSourceConfigSchema,
	scanIntervalMinutes: z.number().int().min(1).max(10_080)
		.default(DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES),
	watcherEnabled: z.boolean().default(true),
	enabled: z.boolean().default(true),
});

/** Validate the library update contract at runtime. */
export const libraryUpdateSchema = libraryCreateSchema.partial();

/** Shared wire contract for library create. */
export type LibraryCreate = z.infer<typeof libraryCreateSchema>;
/** Shared wire contract for library update. */
export type LibraryUpdate = z.infer<typeof libraryUpdateSchema>;

/** Validate the watcher status contract at runtime. */
export const watcherStatusSchema = z.enum(['stopped', 'starting', 'ready', 'fallback', 'error']);
/** Validate the provider-neutral source identity contract at runtime. */
export const sourceIdentitySchema = z.object({
	sourceType: sourceTypeSchema,
	sourceKey: z.string().min(1),
	details: z.record(z.string(), z.string()).default({}),
});
/** Shared wire contract for source identity. */
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;

/** Validate the source candidate summary contract at runtime. */
export const sourceCandidateSummarySchema = z.object({
	discoveredCount: z.number().int().nonnegative(),
	addedCount: z.number().int().nonnegative(),
	missingCount: z.number().int().nonnegative(),
	observedAt: isoDateSchema,
});
/** Shared wire contract for source candidate summary. */
export type SourceCandidateSummary = z.infer<typeof sourceCandidateSummarySchema>;

/** Shared wire contract for library. */
export interface Library extends LibraryCreate {
	id: string;
	watcherStatus: z.infer<typeof watcherStatusSchema>;
	sourceAvailability: SourceAvailability;
	sourceAvailabilityUpdatedAt: string | null;
	reconciliationStatus: ReconciliationStatus;
	pendingRemovalCount: number;
	lastScanStartedAt: string | null;
	lastScanCompletedAt: string | null;
	lastChangeDetectedAt: string | null;
	lastIndexedChangeAt: string | null;
	itemCount: number;
	warningCount: number;
	createdAt: string;
	updatedAt: string;
}

/** Shared wire contract for library reconciliation item. */
export interface LibraryReconciliationItem {
	id: string;
	title: string;
	relativePath: string;
	firstMissingAt: string;
	consecutiveObservations: number;
}

/** Shared wire contract for library reconciliation. */
export interface LibraryReconciliation {
	libraryId: string;
	status: ReconciliationStatus;
	pendingRemovalCount: number;
	requiredObservations: number;
	observationIntervalMinutes: number;
	revision: string | null;
	candidateSourceConfig: LibraryCreate['sourceConfig'] | null;
	sourceChangeCanBeCancelled: boolean;
	candidateSummary: SourceCandidateSummary | null;
	missingItems: LibraryReconciliationItem[];
}

/** Validate the reconciliation action contract at runtime. */
export const reconciliationActionSchema = z.discriminatedUnion('action', [
	z.object({ action: z.literal('confirm-removals'), revision: z.string().min(1) }),
	z.object({ action: z.literal('accept-source'), revision: z.string().min(1) }),
	z.object({ action: z.literal('cancel-source-change'), revision: z.string().min(1) }),
]);
/** Shared wire contract for reconciliation action. */
export type ReconciliationAction = z.infer<typeof reconciliationActionSchema>;

/** Validate the scan trigger contract at runtime. */
export const scanTriggerSchema = z.enum(['initial', 'watcher', 'periodic', 'manual']);
/** Validate the scan status contract at runtime. */
export const scanStatusSchema = z.enum(['running', 'complete', 'partial', 'failed', 'cancelled']);
/** Validate the scan issue contract at runtime. */
export const scanIssueSchema = z.object({
	path: z.string().nullable(),
	code: z.string(),
	message: z.string(),
	severity: z.enum(['warning', 'error']),
});
/** Validate transient progress reported while a scan is running. */
export const scanProgressSchema = z.object({
	phase: z.enum(['discovering', 'processing', 'finalizing']),
	processedCount: z.number().int().nonnegative(),
	totalCount: z.number().int().nonnegative().nullable(),
});
/** Shared wire contract for transient scan progress. */
export type ScanProgress = z.infer<typeof scanProgressSchema>;
/** Validate the scan run contract at runtime. */
export const scanRunSchema = z.object({
	id: idSchema,
	libraryId: idSchema,
	trigger: scanTriggerSchema,
	status: scanStatusSchema,
	startedAt: isoDateSchema,
	completedAt: isoDateSchema.nullable(),
	discoveredCount: z.number().int().nonnegative(),
	changedCount: z.number().int().nonnegative(),
	removedCount: z.number().int().nonnegative(),
	issues: z.array(scanIssueSchema),
});
/** Shared wire contract for scan run. */
export type ScanRun = z.infer<typeof scanRunSchema>;
/** Shared wire contract for scan issue. */
export type ScanIssue = z.infer<typeof scanIssueSchema>;

/** Version of the bounded WebSocket event envelope shared with the SPA. */
export const LIVE_EVENT_PROTOCOL_VERSION = 1 as const;
/** Private-use WebSocket close code requesting reconnection after intentional session replacement. */
export const LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE = 4001 as const;
/** Fields common to every versioned live-event variant. */
const liveEventEnvelopeShape = {
	protocolVersion: z.literal(LIVE_EVENT_PROTOCOL_VERSION),
	eventId: idSchema,
	occurredAt: isoDateSchema,
};
/** Validate the library change contract at runtime. */
export const libraryChangeSchema = z.enum([
	'created',
	'updated',
	'deleted',
	'watcher-status',
	'change-detected',
	'reconciled',
]);
/** Validate the library event data contract at runtime. */
export const libraryEventDataSchema = z.object({
	libraryId: idSchema,
	change: libraryChangeSchema,
	watcherStatus: watcherStatusSchema.optional(),
	affectsProgramming: z.boolean().optional(),
});
/** Validate the scan event data contract at runtime. */
export const scanEventDataSchema = z.object({
	libraryId: idSchema,
	scanId: idSchema,
	trigger: scanTriggerSchema,
	status: scanStatusSchema,
	startedAt: isoDateSchema,
	completedAt: isoDateSchema.nullable(),
	discoveredCount: z.number().int().nonnegative(),
	changedCount: z.number().int().nonnegative(),
	removedCount: z.number().int().nonnegative(),
	issueCount: z.number().int().nonnegative(),
	affectsProgramming: z.boolean().default(false),
	progress: scanProgressSchema.optional(),
});
/** Validate the channel event data contract at runtime. */
export const channelEventDataSchema = z.object({
	channelId: idSchema,
	change: z.enum(['created', 'updated', 'deleted']),
});
/** Validate the playback event data contract at runtime. */
export const playbackEventDataSchema = z.object({
	channelId: idSchema.nullable(),
	reason: z.enum([
		'started',
		'ready',
		'stale',
		'stopped',
		'failed',
		'settings-changed',
		'fallback-applied',
		'playout-synced',
	]),
});
/** Validate the scheduling event data contract at runtime. */
export const schedulingEventDataSchema = z.object({
	entity: z.enum(['program', 'template', 'assignment']),
	change: z.enum(['created', 'updated', 'deleted']),
	id: idSchema,
});
/** Validate the timeline event data contract at runtime. */
export const timelineEventDataSchema = z.object({
	channelId: idSchema,
	status: z.enum(['ready', 'pending', 'failed']),
});

/** Versioned, bounded server event envelope; REST remains the state-recovery contract. */
export const liveEventSchema = z.discriminatedUnion('type', [
	z.object({
		...liveEventEnvelopeShape,
		type: z.literal('system.ready'),
		data: z.object({ connectionId: idSchema }),
	}),
	z.object({
		...liveEventEnvelopeShape,
		type: z.literal('library.changed'),
		data: libraryEventDataSchema,
	}),
	z.object({
		...liveEventEnvelopeShape,
		type: z.literal('scan.changed'),
		data: scanEventDataSchema,
	}),
	z.object({
		...liveEventEnvelopeShape,
		type: z.literal('channel.changed'),
		data: channelEventDataSchema,
	}),
	z.object({
		...liveEventEnvelopeShape,
		type: z.literal('playback.changed'),
		data: playbackEventDataSchema,
	}),
	z.object({
		...liveEventEnvelopeShape,
		type: z.literal('scheduling.changed'),
		data: schedulingEventDataSchema,
	}),
	z.object({
		...liveEventEnvelopeShape,
		type: z.literal('timeline.changed'),
		data: timelineEventDataSchema,
	}),
]);
/** Shared wire contract for live event. */
export type LiveEvent = z.infer<typeof liveEventSchema>;
/** Shared wire contract for live event input. */
export type LiveEventInput
	= | { type: 'library.changed'; data: z.infer<typeof libraryEventDataSchema> }
		| { type: 'scan.changed'; data: z.infer<typeof scanEventDataSchema> }
		| { type: 'channel.changed'; data: z.infer<typeof channelEventDataSchema> }
		| { type: 'playback.changed'; data: z.infer<typeof playbackEventDataSchema> }
		| { type: 'scheduling.changed'; data: z.infer<typeof schedulingEventDataSchema> }
		| { type: 'timeline.changed'; data: z.infer<typeof timelineEventDataSchema> };

/** Validate the audio normalization contract at runtime. */
export const audioNormalizationSchema = z.object({
	format: z.enum(['aac', 'ac3']).nullable().default('aac'),
	bitrateKbps: z.number().int().positive().nullable().default(192),
	bufferKbps: z.number().int().positive().nullable().default(384),
	channels: z.number().int().min(1).max(16).nullable().default(2),
	sampleRateHz: z.number().int().positive().nullable().default(48_000),
	normalizeLoudness: z.boolean().default(true),
	loudness: z
		.object({
			integratedTarget: z.number().nullable().default(-16),
			rangeTarget: z.number().nullable().default(11),
			truePeak: z.number().nullable().default(-1.5),
		})
		.nullable()
		.default({ integratedTarget: -16, rangeTarget: 11, truePeak: -1.5 }),
});

/** Concrete hardware backends understood by the integrated playback worker. */
export const concreteHardwareAccelerationSchema = z.enum([
	'amf',
	'cuda',
	'qsv',
	'rkmpp',
	'vaapi',
	'videotoolbox',
	'vulkan',
]);
/** Hardware-acceleration choices authored in a Moirai channel. */
export const hardwareAccelerationSchema = z.union([
	z.literal('automatic'),
	concreteHardwareAccelerationSchema,
]).nullable();
/** Concrete playback-worker hardware acceleration backend. */
export type ConcreteHardwareAcceleration = z.infer<typeof concreteHardwareAccelerationSchema>;
/** Authored channel acceleration choice, including Moirai-owned automatic selection. */
export type HardwareAcceleration = z.infer<typeof hardwareAccelerationSchema>;

/** Validate the video normalization contract at runtime. */
export const videoNormalizationSchema = z.object({
	format: z.enum(['h264', 'hevc']).nullable().default('h264'),
	bitDepth: z.number().int().min(8).max(16).nullable().default(8),
	width: z.number().int().positive().nullable().default(1920),
	height: z.number().int().positive().nullable().default(1080),
	scalingMode: z.enum(['scale_and_pad', 'stretch', 'crop']).default('scale_and_pad'),
	bitrateKbps: z.number().int().positive().nullable().default(2000),
	bufferKbps: z.number().int().positive().nullable().default(4000),
	accel: hardwareAccelerationSchema.default('automatic'),
	vaapiDevice: z.string().nullable().default(null),
	vaapiDriver: z.enum(['ihd', 'i965', 'radeonsi']).nullable().default(null),
	deinterlace: z.boolean().default(false),
});

/** URI prefix that distinguishes Moirai-managed logos from external artwork. */
export const MANAGED_CHANNEL_LOGO_PREFIX = 'moirai://channel-logo/';
/** Maximum encoded size accepted for a managed channel logo. */
export const CHANNEL_LOGO_MAX_BYTES = 10 * 1024 * 1024;
/** Maximum width or height accepted for a managed channel logo. */
export const CHANNEL_LOGO_MAX_DIMENSION = 4096;
/** Maximum external logo URL length accepted at the API boundary. */
export const CHANNEL_EXTERNAL_LOGO_MAX_LENGTH = 2_048;
/** UUID pattern accepted inside internal managed-logo references. */
const channelLogoIdPattern
	= /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Build the durable internal reference stored with a managed channel logo. */
export function managedChannelLogoUri(channelId: string): string {
	if (!channelLogoIdPattern.test(channelId)) {
		throw new Error('Managed channel logo IDs must be UUIDs');
	}

	return `${MANAGED_CHANNEL_LOGO_PREFIX}${channelId}`;
}

/** Extract and validate the channel identifier from a managed logo URI. */
export function managedChannelLogoId(value: string | null | undefined): string | null {
	if (!value?.startsWith(MANAGED_CHANNEL_LOGO_PREFIX)) {
		return null;
	}

	const id = value.slice(MANAGED_CHANNEL_LOGO_PREFIX.length);
	return channelLogoIdPattern.test(id) ? id : null;
}

/** Return a credential-free HTTP(S) logo URL, excluding Moirai's internal logo references. */
export function externalChannelLogoUrl(value: string | null | undefined): string | null {
	if (!value || value.length > CHANNEL_EXTERNAL_LOGO_MAX_LENGTH) {
		return null;
	}

	try {
		const parsed = new URL(value);
		if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
			return null;
		}

		return parsed.toString();
	}
	catch {
		return null;
	}
}

/** Validate either a managed logo reference or a safe external artwork URL. */
const channelLogoSchema = z
	.string()
	.trim()
	.max(CHANNEL_EXTERNAL_LOGO_MAX_LENGTH)
	.refine(
		(value) => managedChannelLogoId(value) !== null || externalChannelLogoUrl(value) !== null,
		'Channel logos must be credential-free HTTP(S) URLs or managed Moirai logo references',
	);

/** Validate the channel create contract at runtime. */
export const channelCreateSchema = z.object({
	number: z
		.string()
		.trim()
		.min(1)
		.max(32)
		.regex(/^[A-Za-z0-9._-]+$/)
		.refine((value) => value !== '.' && value !== '..', {
			message: 'Channel number cannot be a relative path segment',
		}),
	name: z.string().trim().min(1).max(120),
	logo: channelLogoSchema.nullable().default(null),
	group: z.string().trim().max(120).nullable().default(null),
	audio: audioNormalizationSchema.default({
		format: 'aac',
		bitrateKbps: 192,
		bufferKbps: 384,
		channels: 2,
		sampleRateHz: 48_000,
		normalizeLoudness: true,
		loudness: { integratedTarget: -16, rangeTarget: 11, truePeak: -1.5 },
	}),
	video: videoNormalizationSchema.default({
		format: 'h264',
		bitDepth: 8,
		width: 1920,
		height: 1080,
		scalingMode: 'scale_and_pad',
		bitrateKbps: 2000,
		bufferKbps: 4000,
		accel: 'automatic',
		vaapiDevice: null,
		vaapiDriver: null,
		deinterlace: false,
	}),
	subtitleMode: z.enum(['burn', 'convert']).default('burn'),
	ffmpegPath: z.string().trim().nullable().default(null),
	ffprobePath: z.string().trim().nullable().default(null),
	disabledFilters: z.array(z.string()).default([]),
	preferredFilters: z.array(z.string()).default([]),
}).strict();

/** Validate the channel update contract at runtime. */
export const channelUpdateSchema = channelCreateSchema.partial();
/** Shared wire contract for channel create. */
export type ChannelCreate = z.infer<typeof channelCreateSchema>;
/** Shared wire contract for channel update. */
export type ChannelUpdate = z.infer<typeof channelUpdateSchema>;
/** Shared wire contract for channel. */
export interface Channel extends ChannelCreate {
	id: string;
	createdAt: string;
	updatedAt: string;
}

/** Build the authoritative XMLTV identifier from a channel number and stable UUID. */
export function effectiveChannelTvgId(channel: Pick<Channel, 'id' | 'number'>): string {
	const shortId = channel.id.replaceAll('-', '').slice(0, 8).toLowerCase();
	return `C${channel.number}.${shortId}.moirai.tv`;
}

/** Validate settings that can be changed without restarting the playback engine. */
export const playbackSettingsSchema = z.object({
	maxActiveSessions: z.number().int().min(1).max(32).default(4),
	viewingPreferencesEnabled: z.boolean().default(true),
});
/** Shared wire contract for playback settings. */
export type PlaybackSettings = z.infer<typeof playbackSettingsSchema>;

/** Origin of the managed media currently protecting uncovered playback time. */
export const fallbackFillerSourceSchema = z.enum(['channel', 'global', 'bundled']);
/** Public metadata for one validated playback fallback asset. */
export const fallbackFillerAssetSchema = z.object({
	source: fallbackFillerSourceSchema,
	filename: z.string(),
	contentType: z.string(),
	fileSizeBytes: z.number().int().positive(),
	durationMilliseconds: z.number().int().positive(),
	resolution: z.object({
		width: z.number().int().positive(),
		height: z.number().int().positive(),
	}).nullable(),
	hasAudio: z.boolean(),
	updatedAt: z.iso.datetime({ offset: true }).nullable(),
	previewUrl: z.string(),
});
/** Multipart body documented for one streamed playback fallback upload. */
export const fallbackFillerUploadSchema = z.object({
	file: z.file().describe('Playback fallback video file'),
});
/** Effective fallback plus the optional override owned by the requested scope. */
export const fallbackFillerStatusSchema = z.object({
	override: fallbackFillerAssetSchema.nullable(),
	overrideConfigured: z.boolean(),
	effective: fallbackFillerAssetSchema,
	inherited: fallbackFillerAssetSchema,
	overrideError: z.string().nullable(),
});
/** Public metadata for one validated playback fallback asset. */
export type FallbackFillerAsset = z.infer<typeof fallbackFillerAssetSchema>;
/** Effective fallback and optional scope-specific override. */
export type FallbackFillerStatus = z.infer<typeof fallbackFillerStatusSchema>;

/** One effective locally learned preference shown to an administrator. */
export interface ViewingPreferenceSummary {
	id: string;
	kind: 'item' | 'show';
	title: string;
	score: number;
	lastViewedAt: string;
}

/** Decayed item and show scores consumed by deterministic timeline generation. */
export interface ViewingPreferenceScores {
	itemScores: Record<string, number>;
	showScores: Record<string, number>;
}

/** Server-visible identity and activity for one client currently consuming a channel session. */
export interface PlaybackClientStatus {
	address: string;
	userAgent: string | null;
	firstSeenAt: string;
	lastSeenAt: string;
}

/** Actual encoder acceleration observed in a worker pipeline or its pending state. */
export type PlaybackSessionAcceleration = ConcreteHardwareAcceleration | 'none' | 'pending';

/** Committed programming occupying a channel's current wall-clock playback position. */
export interface PlaybackNowPlayingStatus {
	title: string;
	artworkUrl: string | null;
	startedAt: string;
	finishesAt: string;
}

/** Runtime state of one on-demand channel process. */
export interface ChannelSessionStatus {
	channelId: string;
	channelNumber: string;
	channelName: string;
	state: 'starting' | 'ready' | 'stale' | 'stopping' | 'failed';
	startedAt: string;
	pid: number | null;
	lastError: string | null;
	acceleration: PlaybackSessionAcceleration;
	nowPlaying: PlaybackNowPlayingStatus | null;
	clients: PlaybackClientStatus[];
}

/** Playback engine capability and active-session state. */
export interface PlaybackEngineStatus {
	status: 'ready' | 'degraded';
	engineVersion: string | null;
	contractRevision: string;
	maxActiveSessions: number;
	activeSessionCount: number;
	sessions: ChannelSessionStatus[];
	detail: string | null;
	m3uUrl: string;
	epgUrl: string;
}

/** Shared wire contract for api error body. */
export interface ApiErrorBody {
	code: string;
	message: string;
	details?: unknown;
	requestId: string;
}

/** Shared wire contract for log level. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Shared wire contract for log entry. */
export interface LogEntry {
	id: string;
	time: string;
	level: LogLevel;
	message: string;
	requestId: string | null;
	context: Record<string, unknown>;
}

/** Shared wire contract for log page. */
export interface LogPage {
	entries: LogEntry[];
	nextCursor: string | null;
	scannedBytes: number;
	scanLimitReached: boolean;
}

/** Shared wire contract for log file. */
export interface LogFile {
	name: string;
	size: number;
	modifiedAt: string;
	active: boolean;
}
