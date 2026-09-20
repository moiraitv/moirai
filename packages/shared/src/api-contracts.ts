import { SEMANTIC_HISTORY_LIMIT, MAX_SIMILARITY_QUANTITY, PROGRAM_PREVIEW_ITEM_LIMIT, semanticProgramConfigSchema } from './scheduling.js';
import { z } from 'zod';
import { guideEntrySchema } from './guide.js';
import {
	mediaAvailabilitySchema,
	reconciliationStatusSchema,
	sourceAvailabilitySchema,
} from './availability.js';
import { MAX_LIBRARY_CONTENT_PREVIEW_ITEMS } from './catalog.js';
import {
	channelCreateSchema,
	concreteHardwareAccelerationSchema,
	idSchema,
	isoDateSchema,
	libraryCreateSchema,
	onDiskSourceConfigSchema,
	playbackSettingsSchema,
	scanRunSchema,
	sourceCandidateSummarySchema,
	videoNormalizationSchema,
	watcherStatusSchema,
} from './index.js';
import {
	channelScheduleConfigSchema,
	MAX_EXPLICIT_MEDIA_ITEMS,
	programItemAdditionConfirmationTokenSchema,
	programCreateSchema,
	scheduleTemplateCreateSchema,
} from './scheduling.js';

/** Stable JSON error envelope returned for failed API requests. */
export const apiErrorBodySchema = z.object({
	code: z.string(),
	message: z.string(),
	details: z.unknown().optional(),
	requestId: z.string(),
});

/** Acknowledgement returned when asynchronous work has been queued. */
export const acceptedStatusSchema = z.object({
	status: z.enum(['accepted', 'cancelling']),
});

/** Current configuration and indexing state of one media library. */
export const librarySchema = libraryCreateSchema.extend({
	id: idSchema,
	watcherStatus: watcherStatusSchema,
	sourceAvailability: sourceAvailabilitySchema,
	sourceAvailabilityUpdatedAt: isoDateSchema.nullable(),
	reconciliationStatus: reconciliationStatusSchema,
	pendingRemovalCount: z.number().int().nonnegative(),
	lastScanStartedAt: isoDateSchema.nullable(),
	lastScanCompletedAt: isoDateSchema.nullable(),
	lastChangeDetectedAt: isoDateSchema.nullable(),
	lastIndexedChangeAt: isoDateSchema.nullable(),
	itemCount: z.number().int().nonnegative(),
	warningCount: z.number().int().nonnegative(),
	createdAt: isoDateSchema,
	updatedAt: isoDateSchema,
});

/** Missing-media and source-change state awaiting observation or operator action. */
export const libraryReconciliationSchema = z.object({
	libraryId: idSchema,
	status: reconciliationStatusSchema,
	pendingRemovalCount: z.number().int().nonnegative(),
	requiredObservations: z.number().int().positive(),
	observationIntervalMinutes: z.number().int().nonnegative(),
	revision: z.string().nullable(),
	candidateSourceConfig: onDiskSourceConfigSchema.nullable(),
	sourceChangeCanBeCancelled: z.boolean(),
	candidateSummary: sourceCandidateSummarySchema.nullable(),
	missingItems: z.array(z.object({
		id: idSchema,
		title: z.string(),
		relativePath: z.string(),
		firstMissingAt: isoDateSchema,
		consecutiveObservations: z.number().int().nonnegative(),
	})),
});

/** Configured IPTV channel and normalization settings. */
export const channelSchema = channelCreateSchema.extend({
	id: idSchema,
	createdAt: isoDateSchema,
	updatedAt: isoDateSchema,
});

/** One hierarchical media group in the indexed catalog. */
export const mediaGroupSchema = z.object({
	id: idSchema,
	libraryId: idSchema,
	parentId: idSchema.nullable(),
	kind: z.enum(['show', 'season', 'artist', 'album']),
	title: z.string(),
	sortTitle: z.string(),
	year: z.number().int().nullable(),
	yearEnd: z.number().int().nullable(),
	plot: z.string().nullable(),
	artworkUrl: z.string().nullable(),
	childCount: z.number().int().nonnegative(),
});

/** Provider-scoped identifier attached to one item or group. */
export const mediaExternalIdSchema = z.object({
	provider: z.string(),
	value: z.string(),
	isDefault: z.boolean(),
});

/** Captured embedded or sidecar subtitle metadata. */
export const mediaSubtitleTrackSchema = z.object({
	id: z.string(),
	sourceType: z.enum(['embedded', 'sidecar']),
	partNumber: z.number().int().positive().nullable(),
	streamIndex: z.number().int().nonnegative().nullable(),
	codec: z.string().nullable(),
	format: z.string().nullable(),
	language: z.string().nullable(),
	title: z.string().nullable(),
	isDefault: z.boolean(),
	isForced: z.boolean(),
	isHearingImpaired: z.boolean(),
	isCommentary: z.boolean(),
	relativePaths: z.array(z.string()),
	playbackPaths: z.array(z.string()),
});

/** One physical source in a logical media item. */
export const mediaPartSchema = z.object({
	number: z.number().int().positive(),
	kind: z.enum(['disc', 'part', 'cd', 'dvd', 'disk']).nullable(),
	relativePath: z.string(),
	playbackPath: z.string(),
	durationSeconds: z.number().nonnegative().nullable(),
	subtitleTracks: z.array(mediaSubtitleTrackSchema),
});

/** Indexed playable media item and its source-relative metadata. */
export const mediaItemSchema = z.object({
	id: idSchema,
	libraryId: idSchema,
	groupId: idSchema.nullable(),
	kind: z.string(),
	title: z.string(),
	sortTitle: z.string(),
	relativePath: z.string(),
	playbackPath: z.string(),
	plot: z.string().nullable(),
	year: z.number().int().nullable(),
	releaseDate: z.iso.date().nullable(),
	durationSeconds: z.number().nonnegative().nullable(),
	seasonNumber: z.number().int().nullable(),
	episodeNumber: z.number().int().nullable(),
	episodeEndNumber: z.number().int().nullable(),
	edition: z.string().nullable(),
	externalIds: z.array(mediaExternalIdSchema),
	trackNumber: z.number().int().nullable(),
	discNumber: z.number().int().nullable(),
	artists: z.array(z.string()),
	multipartStatus: z.enum(['none', 'complete', 'incomplete', 'ambiguous']),
	parts: z.array(mediaPartSchema),
	subtitleTracks: z.array(mediaSubtitleTrackSchema),
	metadataStatus: z.enum(['complete', 'incomplete', 'invalid']),
	availability: mediaAvailabilitySchema,
	lastObservedAt: isoDateSchema.nullable(),
	metadata: z.record(z.string(), z.unknown()),
	artworkUrl: z.string().nullable(),
	createdAt: isoDateSchema,
	updatedAt: isoDateSchema,
	fileModifiedAt: isoDateSchema.nullable(),
	dateAddedAt: isoDateSchema,
	titleBucket: z.string(),
});

/** Full media detail returned to the library detail and preview screen. */
export const mediaItemDetailSchema = mediaItemSchema.extend({
	genres: z.array(z.string()),
	directors: z.array(z.string()),
	actors: z.array(z.object({
		name: z.string(),
		role: z.string().nullable(),
		sortOrder: z.number().int().nullable(),
	})),
	writers: z.array(z.string()),
	studios: z.array(z.string()),
	countries: z.array(z.string()),
	certification: z.string().nullable(),
	rating: z.number().nullable(),
	resolution: z.object({ width: z.number().int(), height: z.number().int() }).nullable(),
	fileSizeBytes: z.number().int().nonnegative().nullable(),
	container: z.string().nullable(),
	videoCodecs: z.array(z.string()),
	audioCodecs: z.array(z.string()),
	probeStatus: z.enum(['pending', 'complete', 'failed']),
	probeUpdatedAt: isoDateSchema.nullable(),
	probeErrorCode: z.string().nullable(),
	groupTrail: z.array(z.object({
		id: idSchema,
		kind: z.enum(['show', 'season', 'artist', 'album']),
		title: z.string(),
	})),
});

/** Bounded indexed metadata displayed beside compact media cards. */
export const mediaCardPreviewSchema = z.object({
	id: idSchema,
	title: z.string(),
	year: z.number().int().nullable(),
	plot: z.string().nullable(),
	artworkUrl: z.string().nullable(),
	rating: z.number().min(0).max(10).nullable(),
	primaryGenre: z.string().nullable(),
	actors: z.array(z.string()).max(3),
});

/** Recently indexed media displayed in one library overview carousel. */
export const libraryContentPreviewSchema = z.object({
	libraryId: idSchema,
	items: z.array(mediaItemSchema.pick({
		id: true,
		title: true,
		year: true,
		artworkUrl: true,
		availability: true,
	})).max(MAX_LIBRARY_CONTENT_PREVIEW_ITEMS),
});

/** Metadata explanation shared by catalog and source-picker search results. */
export const mediaSourceMatchSchema = z.object({
	field: z.enum(['title', 'plot', 'genre', 'actor', 'director', 'show', 'season', 'artist', 'album']),
	label: z.string(),
});

/** One media item or hierarchy group returned by catalog browsing. */
export const mediaBrowseEntrySchema = z.object({
	matches: z.array(mediaSourceMatchSchema).optional(),
	key: z.string(),
	kind: z.enum(['item', 'group']),
	navigationKey: z.string(),
	sectionKey: z.string().nullable(),
	sectionLabel: z.string().nullable(),
	item: mediaItemSchema.nullable(),
	group: mediaGroupSchema.nullable(),
});

/** Shared pagination information for catalog result sets. */
export const paginationSchema = z.object({
	page: z.number().int().positive(),
	pageSize: z.number().int().positive(),
	totalEntries: z.number().int().nonnegative(),
	totalPages: z.number().int().nonnegative(),
});

/** Paginated catalog result and contextual navigation anchors. */
export const mediaBrowseResultSchema = z.object({
	entries: z.array(mediaBrowseEntrySchema),
	groups: z.array(mediaGroupSchema),
	items: z.array(mediaItemSchema),
	pagination: paginationSchema,
	navigation: z.array(z.object({
		key: z.string(),
		label: z.string(),
		count: z.number().int().nonnegative(),
		firstPage: z.number().int().positive(),
	})),
});

/** Search result used by explicit-item and media-group program pickers. */
export const mediaSourcePickerResultSchema = z.object({
	entries: z.array(mediaBrowseEntrySchema.extend({
		matches: z.array(mediaSourceMatchSchema),
	})),
	pagination: paginationSchema,
});

/** Normalized genre facet with inclusion and optional exclusion-action counts. */
export const mediaGenreFacetSchema = z.object({
	key: z.string(),
	name: z.string(),
	count: z.number().int().nonnegative(),
	excludeCount: z.number().int().nonnegative().nullable(),
});

/** Reusable rule that defines eligible media and selection behavior. */
export const schedulingProgramSchema = programCreateSchema.extend({
	id: idSchema,
	createdAt: isoDateSchema,
	updatedAt: isoDateSchema,
});

/** Result of adding library items to a new or existing selected-items program. */
export const programItemAdditionResultSchema = z.object({
	program: schedulingProgramSchema,
	created: z.boolean(),
	matchedItemCount: z.number().int().nonnegative(),
	addedItemCount: z.number().int().nonnegative(),
	alreadySelectedCount: z.number().int().nonnegative(),
});

/** Result of creating or extending a program with library hierarchy groups. */
export const programGroupAdditionResultSchema = z.object({
	program: schedulingProgramSchema,
	created: z.boolean(),
	addedGroupCount: z.number().int().nonnegative(),
	alreadySelectedCount: z.number().int().nonnegative(),
});

/** Compact media preview displayed while confirming a large program addition. */
export const programItemAdditionConfirmationItemSchema = mediaItemSchema.pick({
	id: true,
	title: true,
	year: true,
	artworkUrl: true,
});
/** Compact media preview displayed while confirming a large program addition. */
export type ProgramItemAdditionConfirmationItem = z.infer<
	typeof programItemAdditionConfirmationItemSchema
>;

/** Exact current addition and media previews returned when confirmation is required. */
export const programItemAdditionConfirmationDetailsSchema = z.object({
	addedItemCount: z.number().int().nonnegative(),
	alreadySelectedCount: z.number().int().nonnegative(),
	confirmationToken: programItemAdditionConfirmationTokenSchema,
	items: z.array(programItemAdditionConfirmationItemSchema).max(MAX_EXPLICIT_MEDIA_ITEMS),
});

/** Stable conflict response requesting confirmation of a large existing-program addition. */
export const programItemAdditionConfirmationErrorSchema = apiErrorBodySchema.extend({
	code: z.literal('program_item_confirmation_required'),
	details: programItemAdditionConfirmationDetailsSchema,
});

/** Reusable nominal-day schedule structure. */
export const scheduleTemplateSchema = scheduleTemplateCreateSchema.extend({
	id: idSchema,
	createdAt: isoDateSchema,
	updatedAt: isoDateSchema,
});

/** Layered schedule configuration assigned to one channel. */
export const channelScheduleSchema = channelScheduleConfigSchema.extend({
	channelId: idSchema,
	createdAt: isoDateSchema,
	updatedAt: isoDateSchema,
});

/** Complete resource bundle returned by atomic quick channel creation. */
export const quickChannelSetupResultSchema = z.object({
	program: schedulingProgramSchema,
	template: scheduleTemplateSchema,
	channel: channelSchema,
	schedule: channelScheduleSchema,
});
/** Shared result of atomic quick channel creation. */
export type QuickChannelSetupResult = z.infer<typeof quickChannelSetupResultSchema>;

/** One concrete item, filler interval, or dead-air interval in a timeline. */
export const timelineSegmentSchema = z.object({
	id: idSchema,
	role: z.enum(['primary', 'filler', 'dead-air']),
	channelId: idSchema,
	scheduleLayerId: idSchema.nullable(),
	templateId: idSchema,
	slotId: idSchema,
	programId: idSchema.nullable(),
	mediaItemId: idSchema.nullable(),
	title: z.string(),
	subtitle: z.string().optional(),
	playbackPath: z.string().nullable(),
	programAncestry: z.array(z.uuid()).optional(),
	playbackParts: z.array(z.object({
		playbackPath: z.string(),
		durationSeconds: z.number().positive(),
	})).default([]),
	start: isoDateSchema,
	finish: isoDateSchema,
	sourceStartSeconds: z.number().nonnegative(),
	sourceFinishSeconds: z.number().nonnegative().nullable(),
	truncated: z.boolean(),
	posterUrl: z.string().nullable().optional(),
	landscapeUrl: z.string().nullable().optional(),
	fanartUrl: z.string().nullable().optional(),
});

/** Runtime selection cursor persisted separately from authored schedules. */
export const selectionStateRecordSchema = z.object({
	consumerKey: z.string(),
	configFingerprint: z.string(),
	value: z.union([
		z.object({
			type: z.literal('similarity'),
			seed: z.object({
				programId: idSchema, consumerKey: z.string(), generation: z.number().int().positive(),
				itemIds: z.array(idSchema), sourceItemIds: z.array(idSchema),
				config: semanticProgramConfigSchema, createdAt: isoDateSchema,
			}),
			consumedItemIds: z.array(idSchema),
			recentSeeds: z.array(z.array(idSchema).max(MAX_SIMILARITY_QUANTITY)).max(SEMANTIC_HISTORY_LIMIT).optional(),
		}),
		z.object({ type: z.literal('sequential'), nextIndex: z.number().int(), lastItemId: idSchema.nullable() }),
		z.object({
			type: z.literal('shuffle'),
			cycle: z.number().int(),
			cycleItemIds: z.array(idSchema),
			remainingItemIds: z.array(idSchema),
			lastItemId: idSchema.nullable(),
		}),
		z.object({ type: z.literal('random'), counter: z.number().int(), lastItemId: idSchema.nullable() }),
		z.object({
			type: z.literal('weighted-random'),
			counter: z.number().int(),
			lastItemId: idSchema.nullable(),
		}),
		z.object({
			type: z.literal('sequence'),
			entryIndex: z.number().int(),
			selectedInEntry: z.number().int(),
			completed: z.boolean(),
		}),
	]),
	updatedAt: isoDateSchema,
});

/** Duration-aware timeline returned for draft or persisted schedule previews. */
export const timelinePreviewSchema = z.object({
	programNames: z.record(z.string(), z.string()).optional(),
	entries: z.array(guideEntrySchema).optional(),
	channelId: idSchema,
	timeZone: z.string(),
	startDate: z.iso.date(),
	days: z.number().int().positive(),
	segments: z.array(timelineSegmentSchema),
	issues: z.array(z.object({
		code: z.string(),
		message: z.string(),
		scheduleLayerId: idSchema.nullable(),
		templateId: idSchema.nullable(),
		slotId: idSchema.nullable(),
		programId: idSchema.nullable(),
		mediaItemId: idSchema.nullable(),
		occurrences: z.array(z.object({
			start: isoDateSchema,
			finish: isoDateSchema.nullable(),
			boundaryOrigin: z.enum(['template', 'layer-entry', 'layer-exit']).nullable(),
		})).default([]),
		occurrenceCount: z.number().int().nonnegative().default(0),
	})),
	proposedState: z.array(selectionStateRecordSchema),
});

/** Durable guide window returned for all configured channels. */
export const scheduleGuideSchema = z.object({
	timeZone: z.string(),
	startDate: z.iso.date(),
	requestedDays: z.number().int().positive(),
	days: z.number().int().positive(),
	segmentLimitApplied: z.boolean(),
	committedStartDate: z.iso.date().optional(),
	committedEndDate: z.iso.date().optional(),
	committedAt: isoDateSchema.optional(),
	channels: z.array(z.object({ channelId: idSchema, preview: timelinePreviewSchema, entries: z.array(guideEntrySchema).optional() })),
});

/** Materialized timeline health for one channel. */
export const timelineMaterializationStatusSchema = z.object({
	channelId: idSchema,
	health: z.enum(['ready', 'pending', 'generating', 'failed']),
	windowStart: isoDateSchema.nullable(),
	windowEnd: isoDateSchema.nullable(),
	committedAt: isoDateSchema.nullable(),
	pendingSince: isoDateSchema.nullable(),
	applyAfter: isoDateSchema.nullable(),
	lastError: z.string().nullable(),
});

/** Committed programming and timing exposed for one active channel session. */
export const playbackNowPlayingStatusSchema = z.object({
	title: z.string(),
	artworkUrl: z.string().nullable(),
	startedAt: isoDateSchema,
	finishesAt: isoDateSchema,
});

/** Playback engine capability and active channel-session state. */
export const playbackEngineStatusSchema = z.object({
	status: z.enum(['ready', 'degraded']),
	engineVersion: z.string().nullable(),
	contractRevision: z.string(),
	maxActiveSessions: z.number().int().positive(),
	activeSessionCount: z.number().int().nonnegative(),
	sessions: z.array(z.object({
		channelId: idSchema,
		channelNumber: z.string(),
		channelName: z.string(),
		state: z.enum(['starting', 'ready', 'stale', 'stopping', 'failed']),
		startedAt: isoDateSchema,
		pid: z.number().int().nullable(),
		lastError: z.string().nullable(),
		acceleration: z.union([
			concreteHardwareAccelerationSchema,
			z.enum(['none', 'pending']),
		]),
		nowPlaying: playbackNowPlayingStatusSchema.nullable(),
		clients: z.array(z.object({
			address: z.string().min(1).max(128),
			userAgent: z.string().max(512).nullable(),
			firstSeenAt: isoDateSchema,
			lastSeenAt: isoDateSchema,
		})).max(16),
	})),
	detail: z.string().nullable(),
	m3uUrl: z.string(),
	epgUrl: z.string(),
});

/** Runtime-adjustable playback settings response. */
export const playbackSettingsResponseSchema = playbackSettingsSchema;

/** One effective locally learned preference returned to an administrator. */
export const viewingPreferenceSummarySchema = z.object({
	id: idSchema,
	kind: z.enum(['item', 'show']),
	title: z.string(),
	score: z.number().nonnegative(),
	lastViewedAt: z.iso.datetime({ offset: true }),
	artworkUrl: z.string().nullable(),
	year: z.number().int().nullable(),
	subtitle: z.string(),
	parentTitle: z.string().nullable(),
	previewItemId: idSchema,
});

/** Bounded viewing-preference list response. */
export const viewingPreferenceListSchema = z.array(viewingPreferenceSummarySchema).max(100);

/** Explicit destructive confirmation required to clear local viewing history. */
export const clearViewingPreferencesSchema = z.object({
	confirmation: z.literal('CLEAR VIEWING HISTORY'),
});

/** Draft channel values used to predict Moirai's automatic hardware selection. */
export const hardwareAccelerationPredictionRequestSchema = videoNormalizationSchema.pick({
	format: true,
	bitDepth: true,
	width: true,
	height: true,
	vaapiDevice: true,
	vaapiDriver: true,
}).extend({
	ffmpegPath: z.string().trim().max(4_096).nullable().default(null),
});

/** Result of probing server-visible hardware for one draft channel target. */
export const hardwareAccelerationPredictionSchema = z.object({
	outcome: z.enum(['hardware', 'none', 'indeterminate']),
	accel: concreteHardwareAccelerationSchema.nullable(),
	detail: z.string(),
});

/** Draft channel values accepted by hardware-acceleration prediction. */
export type HardwareAccelerationPredictionRequest = z.infer<
	typeof hardwareAccelerationPredictionRequestSchema
>;
/** Server-side prediction for Moirai's automatic hardware selection. */
export type HardwareAccelerationPrediction = z.infer<typeof hardwareAccelerationPredictionSchema>;

/** Retained operational log page. */
export const logPageSchema = z.object({
	entries: z.array(z.object({
		id: z.string(),
		time: isoDateSchema,
		level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
		message: z.string(),
		requestId: z.string().nullable(),
		context: z.record(z.string(), z.unknown()),
	})),
	nextCursor: z.string().nullable(),
	scannedBytes: z.number().int().nonnegative(),
	scanLimitReached: z.boolean(),
});

/** One retained operational log file available for download. */
export const logFileSchema = z.object({
	name: z.string(),
	size: z.number().int().nonnegative(),
	modifiedAt: isoDateSchema,
	active: z.boolean(),
});

/** Retained scan-history response. */
export const scanHistorySchema = z.array(scanRunSchema);

/** Server capabilities and configured public-network behavior. */
export const appCapabilitiesSchema = z.object({
	libraryTypes: z.array(z.string()),
	sourceTypes: z.array(z.string()),
	mediaExtensions: z.array(z.string()),
	etvContractRevision: z.string(),
	authentication: z.literal('session'),
	timeZone: z.string(),
	publicUrl: z.url(),
	publicUrlStatus: z.enum(['configured', 'unreachable-default']),
	maxExplicitMediaItems: z.number().int().positive().max(MAX_EXPLICIT_MEDIA_ITEMS),
});

/** Safe administrator identity returned after local or Logto authentication. */
export const authenticationIdentitySchema = z.object({
	id: z.uuid(),
	provider: z.enum(['local', 'logto']),
	displayName: z.string().min(1).max(200),
	username: z.string().nullable(),
});

/** Current initialization and browser-session state. */
export const authenticationStateSchema = z.object({
	status: z.enum(['uninitialized', 'anonymous', 'authenticated']),
	methods: z.object({
		local: z.boolean(),
		logto: z.boolean(),
	}),
	localUsername: z.string().nullable(),
	identity: authenticationIdentitySchema.nullable(),
	csrfToken: z.string().nullable(),
});

/** Local administrator username boundary applied before and after canonical normalization. */
export const localAuthenticationUsernameSchema = z.string().trim().min(3).max(64);

/** First local administrator credentials accepted before any identity exists. */
export const localAuthenticationSetupSchema = z.object({
	username: localAuthenticationUsernameSchema,
	password: z.string().min(15).max(256),
});

/** Local credentials exchanged for one revocable browser session. */
export const localAuthenticationLoginSchema = localAuthenticationSetupSchema;

/** Existing or new local credentials changed by an authenticated administrator. */
export const localAuthenticationCredentialsSchema = localAuthenticationSetupSchema.extend({
	currentPassword: z.string().min(1).max(256).nullable(),
});

/** One-time operator recovery code and replacement local credentials. */
export const localAuthenticationRecoverySchema = localAuthenticationSetupSchema.extend({
	token: z.string().min(32).max(512),
});

/** Safe relative destination retained through a provider redirect. */
export const authenticationReturnQuerySchema = z.object({
	returnTo: z.string().max(2_048).optional(),
});

/** Lightweight process-liveness response. */
export const livenessSchema = z.object({ status: z.literal('ok') });

/** Public database-migration progress shown before the application is fully up. */
export const startupStatusSchema = z.object({
	status: z.enum(['migrating', 'ready', 'failed']),
	applied: z.number().int().min(0),
	total: z.number().int().min(0),
	percent: z.number().int().min(0).max(100),
	currentTag: z.string().optional(),
	error: z.string().optional(),
});

/** Detailed service readiness and degraded-state response. */
export const readinessSchema = z.object({
	status: z.enum(['ready', 'degraded']),
	checks: z.array(z.object({
		name: z.enum([
			'database',
			'scanner',
			'timeline',
			'maintenance',
			'playbackEngine',
			'playoutSync',
			'mediaProbe',
			'resourcePressure',
			'mediaSources',
			'migration',
		]),
		status: z.enum(['ready', 'degraded', 'disabled']),
		essential: z.boolean(),
		detail: z.string().optional(),
	})),
});

/** Bounded data-identity conflicts requiring operator review. */
export const dataConflictReportSchema = z.object({
	conflicts: z.array(z.object({
		id: z.string(),
		kind: z.enum(['show-external-id', 'resource-name', 'channel-number']),
		severity: z.enum(['warning', 'error']),
		resourceType: z.enum(['library', 'program', 'template', 'channel']),
		resourceId: idSchema.nullable(),
		libraryId: idSchema.nullable(),
		title: z.string(),
		message: z.string(),
		paths: z.array(z.string()),
		observedAt: isoDateSchema.nullable(),
	})),
	truncated: z.boolean(),
});

/** Number of failed embeddings explicitly queued for another local inference attempt. */
export const semanticRetryResultSchema = z.object({ queued: z.number().int().nonnegative() });

/** Program source availability shown by the scheduling overview. */
export const schedulingProgramStatusSchema = z.object({
	currentSets: z.array(z.object({ channelName: z.string().optional(), programId: idSchema, consumerKey: z.string(), generation: z.number().int(),
		total: z.number().int(), remaining: z.number().int(), requestedTotal: z.number().int().positive().optional() })).optional(),
	programId: idSchema,
	health: z.enum(['ready', 'degraded', 'unavailable', 'missing', 'empty']),
	sourceLabel: z.string(),
	indexedItemCount: z.number().int().nonnegative(),
	availableItemCount: z.number().int().nonnegative(),
	previewItems: z.array(mediaItemSchema.pick({
		id: true,
		libraryId: true,
		title: true,
		year: true,
		artworkUrl: true,
		availability: true,
	})).max(PROGRAM_PREVIEW_ITEM_LIMIT),
	previewPending: z.boolean().optional(),
	matchingItemCount: z.number().int().nonnegative().optional(),
	requestedItemCount: z.number().int().positive().optional(),
	failedEmbeddingCount: z.number().int().nonnegative().optional(),
	excludedPreviewItems: z.array(mediaItemSchema.pick({
		id: true, libraryId: true, title: true, year: true, artworkUrl: true, availability: true,
	})).max(PROGRAM_PREVIEW_ITEM_LIMIT).optional(),
});

/** One cursor page of currently indexed matches for a Quick Setup library query. */
export const quickChannelQueryPreviewResultSchema = z.object({
	indexedItemCount: z.number().int().nonnegative(),
	items: z.array(mediaItemSchema.pick({
		id: true,
		libraryId: true,
		title: true,
		year: true,
		artworkUrl: true,
		availability: true,
	})).max(48),
	nextCursor: z.string().nullable(),
});
/** Shared result of previewing a Quick Setup library query. */
export type QuickChannelQueryPreviewResult = z.infer<
	typeof quickChannelQueryPreviewResultSchema
>;

/** Read-only review samples and one resolved local day for an uncommitted Quick Setup. */
export const quickChannelSetupPreviewResultSchema = z.object({
	library: z.object({ items: schedulingProgramStatusSchema.shape.previewItems, indexedItemCount: z.number().int().nonnegative() }),
	programming: z.object({ items: schedulingProgramStatusSchema.shape.previewItems, indexedItemCount: z.number().int().nonnegative() }),
	templateName: z.string(),
	schedule: timelinePreviewSchema,
});
/** Shared response for the enriched Quick Setup review. */
export type QuickChannelSetupPreviewResult = z.infer<typeof quickChannelSetupPreviewResultSchema>;

/** Scheduling editor overview assembled from authored configuration and catalog health. */
export const schedulingOverviewSchema = z.object({
	programs: z.array(schedulingProgramSchema),
	templates: z.array(scheduleTemplateSchema),
	channelSchedules: z.array(channelScheduleSchema),
	programStatuses: z.array(schedulingProgramStatusSchema),
});

/** Safe source details returned for a selected committed guide segment. */
export const guideSegmentDetailSchema = z.object({
	segment: timelineSegmentSchema.omit({ playbackPath: true }),
	media: z.object({
		id: idSchema,
		libraryId: idSchema,
		title: z.string(),
		kind: z.string(),
		durationSeconds: z.number().nonnegative().nullable(),
		seasonNumber: z.number().int().nullable(),
		episodeNumber: z.number().int().nullable(),
		episodeEndNumber: z.number().int().nullable(),
		genreNames: z.array(z.string()),
		plot: z.string().nullable(),
		year: z.number().int().nullable(),
		artworkUrl: z.string().nullable(),
		availability: mediaAvailabilitySchema,
	}).nullable(),
	catalogItemPresent: z.boolean(),
	source: z.object({
		role: z.enum(['primary', 'filler', 'dead-air']),
		programId: idSchema.nullable(),
		programName: z.string().nullable(),
		templateId: idSchema,
		templateName: z.string().nullable(),
		libraryId: idSchema.nullable(),
		libraryName: z.string().nullable(),
	}),
});
