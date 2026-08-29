import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
	ChannelCreate,
	ChannelScheduleLayer,
	ChannelScheduleConfig,
	FillerConfig,
	Library,
	LibraryCreate,
	MediaItem,
	PlaybackSettings,
	ProgramConfig,
	ScheduleBoundary,
	ScheduleSlot,
	ScanIssue,
	SchedulableMedia,
	SelectionStateRecord,
	SelectionStateValue,
	SourceCandidateSummary,
	SourceIdentity,
	TimelineIssue,
} from '@moirai/shared';
import { DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES } from '@moirai/shared';

/** Shared creation and update columns used by mutable application records. */
const timestamps = {
	createdAt: text('created_at')
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
};

/**
 * Schema for `libraries`.
 *
 * Stores configured media sources together with their scan, watcher, availability, and
 * reconciliation state.
 */
export const libraries = sqliteTable('libraries', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	nameKey: text('name_key'),
	typeKey: text('type_key').notNull(),
	sourceType: text('source_type').notNull(),
	sourceConfig: text('source_config', { mode: 'json' })
		.$type<LibraryCreate['sourceConfig']>()
		.notNull(),
	scanIntervalMinutes: integer('scan_interval_minutes')
		.notNull()
		.default(DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES),
	watcherEnabled: integer('watcher_enabled', { mode: 'boolean' }).notNull().default(true),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	watcherStatus: text('watcher_status').notNull().default('stopped'),
	sourceAvailability: text('source_availability')
		.$type<Library['sourceAvailability']>()
		.notNull()
		.default('available'),
	sourceAvailabilityUpdatedAt: text('source_availability_updated_at'),
	acceptedSourceIdentity: text('accepted_source_identity', {
		mode: 'json',
	}).$type<SourceIdentity>(),
	pendingSourceDefinition: text('pending_source_definition', { mode: 'json' }).$type<{
		typeKey: string;
		sourceType: string;
		sourceConfig: LibraryCreate['sourceConfig'];
	}>(),
	candidateSourceIdentity: text('candidate_source_identity', {
		mode: 'json',
	}).$type<SourceIdentity>(),
	candidateManifest: text('candidate_manifest'),
	candidateSummary: text('candidate_summary', { mode: 'json' }).$type<SourceCandidateSummary>(),
	reconciliationStatus: text('reconciliation_status')
		.$type<Library['reconciliationStatus']>()
		.notNull()
		.default('idle'),
	reconciliationRevision: text('reconciliation_revision'),
	pendingRemovalCount: integer('pending_removal_count').notNull().default(0),
	lastScanStartedAt: text('last_scan_started_at'),
	lastScanCompletedAt: text('last_scan_completed_at'),
	lastChangeDetectedAt: text('last_change_detected_at'),
	lastIndexedChangeAt: text('last_indexed_change_at'),
	warningCount: integer('warning_count').notNull().default(0),
	...timestamps,
}, (table) => [uniqueIndex('libraries_name_key_unique').on(table.nameKey)]);

/**
 * Schema for `mediaGroups`.
 *
 * Stores the browsable hierarchy above playable files, such as shows and seasons.
 */
export const mediaGroups = sqliteTable(
	'media_groups',
	{
		id: text('id').primaryKey(),
		libraryId: text('library_id')
			.notNull()
			.references(() => libraries.id, { onDelete: 'cascade' }),
		parentId: text('parent_id'),
		stableKey: text('stable_key').notNull(),
		sourceKey: text('source_key'),
		kind: text('kind').notNull(),
		title: text('title').notNull(),
		sortTitle: text('sort_title').notNull(),
		year: integer('year'),
		plot: text('plot'),
		metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
		artworkRelativePath: text('artwork_relative_path'),
		...timestamps,
	},
	(table) => [
		uniqueIndex('media_groups_library_stable_key').on(table.libraryId, table.stableKey),
		uniqueIndex('media_groups_library_source_key').on(table.libraryId, table.sourceKey),
		index('media_groups_parent_idx').on(table.libraryId, table.parentId),
	],
);

/**
 * Schema for `catalogConflicts`.
 *
 * These are catalog identity conflicts observed during the latest healthy source scan.
 */
export const catalogConflicts = sqliteTable(
	'catalog_conflicts',
	{
		libraryId: text('library_id')
			.notNull()
			.references(() => libraries.id, { onDelete: 'cascade' }),
		conflictKey: text('conflict_key').notNull(),
		kind: text('kind').notNull(),
		provider: text('provider'),
		externalId: text('external_id'),
		paths: text('paths', { mode: 'json' }).$type<string[]>().notNull(),
		message: text('message').notNull(),
		observedAt: text('observed_at').notNull(),
	},
	(table) => [
		uniqueIndex('catalog_conflicts_library_key').on(table.libraryId, table.conflictKey),
		index('catalog_conflicts_library_idx').on(table.libraryId),
	],
);

/**
 * Schema for `mediaItems`.
 *
 * Stores indexed playable files, presentation metadata, measured playback properties, and
 * current source availability.
 */
export const mediaItems = sqliteTable(
	'media_items',
	{
		id: text('id').primaryKey(),
		libraryId: text('library_id')
			.notNull()
			.references(() => libraries.id, { onDelete: 'cascade' }),
		groupId: text('group_id').references(() => mediaGroups.id, { onDelete: 'set null' }),
		stableKey: text('stable_key').notNull(),
		kind: text('kind').notNull(),
		title: text('title').notNull(),
		sortTitle: text('sort_title').notNull(),
		relativePath: text('relative_path').notNull(),
		playbackPath: text('playback_path').notNull(),
		nfoRelativePath: text('nfo_relative_path'),
		plot: text('plot'),
		year: integer('year'),
		durationSeconds: integer('duration_seconds'),
		durationMilliseconds: integer('duration_milliseconds'),
		probeFingerprint: text('probe_fingerprint'),
		probeStatus: text('probe_status').$type<'pending' | 'complete' | 'failed'>().notNull().default('pending'),
		probeUpdatedAt: text('probe_updated_at'),
		probeErrorCode: text('probe_error_code'),
		technicalMetadata: text('technical_metadata', { mode: 'json' })
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		seasonNumber: integer('season_number'),
		episodeNumber: integer('episode_number'),
		episodeEndNumber: integer('episode_end_number'),
		edition: text('edition'),
		externalIds: text('external_ids', { mode: 'json' })
			.$type<MediaItem['externalIds']>()
			.notNull()
			.default([]),
		trackNumber: integer('track_number'),
		discNumber: integer('disc_number'),
		artists: text('artists', { mode: 'json' }).$type<string[]>().notNull().default([]),
		multipartStatus: text('multipart_status')
			.$type<MediaItem['multipartStatus']>()
			.notNull()
			.default('none'),
		parts: text('parts', { mode: 'json' }).$type<MediaItem['parts']>().notNull().default([]),
		subtitleTracks: text('subtitle_tracks', { mode: 'json' })
			.$type<MediaItem['subtitleTracks']>()
			.notNull()
			.default([]),
		metadataStatus: text('metadata_status').notNull(),
		availability: text('availability')
			.$type<MediaItem['availability']>()
			.notNull()
			.default('available'),
		lastObservedAt: text('last_observed_at'),
		metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
		artworkRelativePath: text('artwork_relative_path'),
		fingerprint: text('fingerprint').notNull(),
		fileModifiedAt: text('file_modified_at'),
		dateAddedAt: text('date_added_at').notNull(),
		titleBucket: text('title_bucket').notNull().default('#'),
		...timestamps,
	},
	(table) => [
		uniqueIndex('media_items_library_relative_path').on(table.libraryId, table.relativePath),
		index('media_items_library_group_idx').on(table.libraryId, table.groupId),
		index('media_items_library_title_idx').on(table.libraryId, table.sortTitle),
		index('media_items_library_added_idx').on(table.libraryId, table.dateAddedAt),
		index('media_items_library_bucket_idx').on(table.libraryId, table.titleBucket),
	],
);

/** Compatibility aliases from absorbed multipart component IDs to their logical item. */
export const mediaItemAliases = sqliteTable(
	'media_item_aliases',
	{
		aliasId: text('alias_id').primaryKey(),
		libraryId: text('library_id')
			.notNull()
			.references(() => libraries.id, { onDelete: 'cascade' }),
		itemId: text('item_id')
			.notNull()
			.references(() => mediaItems.id, { onDelete: 'cascade' }),
		createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => [index('media_item_aliases_item_idx').on(table.itemId)],
);

/**
 * Schema for `mediaItemGenres`.
 *
 * Stores normalized genre associations used to browse, search, filter, and schedule media.
 */
export const mediaItemGenres = sqliteTable(
	'media_item_genres',
	{
		itemId: text('item_id')
			.notNull()
			.references(() => mediaItems.id, { onDelete: 'cascade' }),
		libraryId: text('library_id')
			.notNull()
			.references(() => libraries.id, { onDelete: 'cascade' }),
		genreKey: text('genre_key').notNull(),
		genreName: text('genre_name').notNull(),
	},
	(table) => [
		uniqueIndex('media_item_genres_item_key').on(table.itemId, table.genreKey),
		index('media_item_genres_library_key_idx').on(table.libraryId, table.genreKey, table.itemId),
	],
);

/**
 * Schema for `mediaItemPeople`.
 *
 * Stores searchable actor and director associations extracted from media metadata.
 */
export const mediaItemPeople = sqliteTable(
	'media_item_people',
	{
		itemId: text('item_id')
			.notNull()
			.references(() => mediaItems.id, { onDelete: 'cascade' }),
		libraryId: text('library_id')
			.notNull()
			.references(() => libraries.id, { onDelete: 'cascade' }),
		personType: text('person_type').$type<'actor' | 'director'>().notNull(),
		name: text('name').notNull(),
		normalizedName: text('normalized_name').notNull(),
		role: text('role'),
		sortOrder: integer('sort_order'),
	},
	(table) => [
		uniqueIndex('media_item_people_item_type_name').on(
			table.itemId,
			table.personType,
			table.normalizedName,
		),
		index('media_item_people_library_type_name_idx').on(
			table.libraryId,
			table.personType,
			table.normalizedName,
			table.itemId,
		),
	],
);

/**
 * Schema for `scanRuns`.
 *
 * Stores scan history, including each run's trigger, outcome, item counts, and issues.
 */
export const scanRuns = sqliteTable(
	'scan_runs',
	{
		id: text('id').primaryKey(),
		libraryId: text('library_id')
			.notNull()
			.references(() => libraries.id, { onDelete: 'cascade' }),
		scanTrigger: text('scan_trigger').notNull(),
		status: text('status').notNull(),
		startedAt: text('started_at').notNull(),
		completedAt: text('completed_at'),
		discoveredCount: integer('discovered_count').notNull().default(0),
		changedCount: integer('changed_count').notNull().default(0),
		removedCount: integer('removed_count').notNull().default(0),
		issues: text('issues', { mode: 'json' }).$type<ScanIssue[]>().notNull(),
	},
	(table) => [index('scan_runs_library_started_idx').on(table.libraryId, table.startedAt)],
);

/**
 * Schema for `mediaRemovalTombstones`.
 *
 * These are effectively "trashed" records of media items, which reside here before full deletion
 * once removal is confirmed.
 */
export const mediaRemovalTombstones = sqliteTable(
	'media_removal_tombstones',
	{
		itemId: text('item_id')
			.primaryKey()
			.references(() => mediaItems.id, { onDelete: 'cascade' }),
		libraryId: text('library_id')
			.notNull()
			.references(() => libraries.id, { onDelete: 'cascade' }),
		sourceIdentityHash: text('source_identity_hash').notNull(),
		firstMissingAt: text('first_missing_at').notNull(),
		lastMissingAt: text('last_missing_at').notNull(),
		lastCountedAt: text('last_counted_at'),
		consecutiveObservations: integer('consecutive_observations').notNull().default(0),
		lastScanId: text('last_scan_id').references(() => scanRuns.id, { onDelete: 'set null' }),
	},
	(table) => [index('media_removal_tombstones_library_idx').on(table.libraryId, table.itemId)],
);

/**
 * Schema for `channels`.
 *
 * Stores IPTV channel identity, presentation, normalization, logo, and output configuration.
 */
export const channels = sqliteTable(
	'channels',
	{
		id: text('id').primaryKey(),
		number: text('number').notNull().unique(),
		numberKey: text('number_key'),
		name: text('name').notNull(),
		effectiveTvgId: text('effective_tvg_id'),
		config: text('config', { mode: 'json' }).$type<ChannelCreate>().notNull(),
		...timestamps,
	},
	(table) => [
		index('channels_effective_tvg_id_idx').on(table.effectiveTvgId),
		uniqueIndex('channels_number_key_unique').on(table.numberKey),
	],
);

/**
 * Schema for `schedulingPrograms`.
 *
 * Stores reusable content rules and the strategies used to select from them.
 */
export const schedulingPrograms = sqliteTable('scheduling_programs', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	nameKey: text('name_key'),
	config: text('config', { mode: 'json' }).$type<ProgramConfig>().notNull(),
	...timestamps,
}, (table) => [uniqueIndex('scheduling_programs_name_key_unique').on(table.nameKey)]);

/**
 * Schema for `scheduleTemplates`.
 *
 * Stores reusable schedule periods and their default filler configuration.
 */
export const scheduleTemplates = sqliteTable('schedule_templates', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	nameKey: text('name_key'),
	period: text('period').$type<'day'>().notNull().default('day'),
	defaultFiller: text('default_filler', { mode: 'json' }).$type<FillerConfig | null>(),
	...timestamps,
}, (table) => [uniqueIndex('schedule_templates_name_key_unique').on(table.nameKey)]);

/**
 * Schema for `scheduleSlots`.
 *
 * Stores the ordered time allocations, program assignments, and fill behavior authored within
 * each template.
 */
export const scheduleSlots = sqliteTable(
	'schedule_slots',
	{
		id: text('id').primaryKey(),
		templateId: text('template_id')
			.notNull()
			.references(() => scheduleTemplates.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		startSeconds: integer('start_seconds').notNull(),
		programId: text('program_id').references(() => schedulingPrograms.id, { onDelete: 'restrict' }),
		stateScope: text('state_scope').$type<ScheduleSlot['stateScope']>().notNull(),
		startEligibility: text('start_eligibility', { mode: 'json' })
			.$type<ScheduleSlot['startEligibility']>()
			.notNull(),
		filler: text('filler', { mode: 'json' }).$type<ScheduleSlot['filler']>().notNull(),
	},
	(table) => [
		uniqueIndex('schedule_slots_template_position').on(table.templateId, table.position),
		uniqueIndex('schedule_slots_template_start').on(table.templateId, table.startSeconds),
	],
);

/**
 * Schema for `scheduleBoundaries`.
 *
 * Stores transitions between adjacent slots and the policies used to resolve them against
 * actual media durations.
 */
export const scheduleBoundaries = sqliteTable(
	'schedule_boundaries',
	{
		id: text('id').primaryKey(),
		templateId: text('template_id')
			.notNull()
			.references(() => scheduleTemplates.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		leftSlotId: text('left_slot_id')
			.notNull()
			.references(() => scheduleSlots.id, { onDelete: 'cascade' }),
		rightSlotId: text('right_slot_id')
			.notNull()
			.references(() => scheduleSlots.id, { onDelete: 'cascade' }),
		targetSeconds: integer('target_seconds').notNull(),
		policy: text('policy').$type<ScheduleBoundary['policy']>().notNull(),
		maxDriftSeconds: integer('max_drift_seconds'),
		fallback: text('fallback').$type<ScheduleBoundary['fallback']>().notNull(),
	},
	(table) => [
		uniqueIndex('schedule_boundaries_template_position').on(table.templateId, table.position),
		uniqueIndex('schedule_boundaries_template_target').on(table.templateId, table.targetSeconds),
	],
);

/**
 * Schema for `channelSchedules`.
 *
 * Stores each channel's base template and channel-level scheduling configuration.
 */
export const channelSchedules = sqliteTable('channel_schedules', {
	channelId: text('channel_id')
		.primaryKey()
		.references(() => channels.id, { onDelete: 'cascade' }),
	defaultTemplateId: text('default_template_id')
		.notNull()
		.references(() => scheduleTemplates.id, { onDelete: 'restrict' }),
	config: text('config', { mode: 'json' }).$type<ChannelScheduleConfig>().notNull(),
	...timestamps,
});

/**
 * Schema for `channelScheduleLayers`.
 *
 * These are the optional layers above a channel's base schedule template that may apply depending
 * on how the predicate matches (e.g., always show during the 5:00-7:00 pm hours).
 */
export const channelScheduleLayers = sqliteTable(
	'channel_schedule_layers',
	{
		id: text('id').primaryKey(),
		channelId: text('channel_id')
			.notNull()
			.references(() => channelSchedules.channelId, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		templateId: text('template_id')
			.notNull()
			.references(() => scheduleTemplates.id, { onDelete: 'restrict' }),
		predicate: text('predicate', { mode: 'json' })
			.$type<ChannelScheduleLayer['predicate']>()
			.notNull(),
		entryBoundary: text('entry_boundary', { mode: 'json' })
			.$type<ChannelScheduleLayer['entryBoundary']>()
			.notNull(),
		exitBoundary: text('exit_boundary', { mode: 'json' })
			.$type<ChannelScheduleLayer['exitBoundary']>()
			.notNull(),
	},
	(table) => [
		uniqueIndex('channel_schedule_layers_channel_position').on(table.channelId, table.position),
	],
);

/**
 * Schema for `selectionStates`.
 *
 * This stores the persistent playback cursors used by the scheduling engine.
 */
export const selectionStates = sqliteTable(
	'selection_states',
	{
		consumerKey: text('consumer_key').primaryKey(),
		channelId: text('channel_id')
			.notNull()
			.references(() => channels.id, { onDelete: 'cascade' }),
		configFingerprint: text('config_fingerprint').notNull(),
		value: text('value', { mode: 'json' }).$type<SelectionStateValue>().notNull(),
		updatedAt: text('updated_at')
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => [index('selection_states_channel_idx').on(table.channelId)],
);

/**
 * Schema for `timelineMaterializations`.
 *
 * Stores each channel's currently generated timeline, generation checkpoint, health, and the input
 * fingerprint used to decide when regeneration is needed.
 */
export const timelineMaterializations = sqliteTable('timeline_materializations', {
	channelId: text('channel_id')
		.primaryKey()
		.references(() => channels.id, { onDelete: 'cascade' }),
	status: text('status').$type<'ready' | 'pending' | 'generating' | 'failed'>().notNull(),
	windowStart: text('window_start').notNull(),
	windowEnd: text('window_end').notNull(),
	continuationAt: text('continuation_at').notNull(),
	inputFingerprint: text('input_fingerprint').notNull(),
	baseState: text('base_state', { mode: 'json' }).$type<SelectionStateRecord[]>().notNull(),
	issues: text('issues', { mode: 'json' }).$type<TimelineIssue[]>().notNull(),
	committedAt: text('committed_at').notNull(),
	pendingSince: text('pending_since'),
	applyAfter: text('apply_after'),
	lastError: text('last_error'),
	...timestamps,
});

/**
 * Schema for `materializedTimelineSegments`.
 *
 * Stores concrete, timestamped primary, filler, and dead-air entries used by the guide and playout
 * output, along with the media and cursor snapshots needed for stable regeneration.
 */
export const materializedTimelineSegments = sqliteTable(
	'materialized_timeline_segments',
	{
		id: text('id').primaryKey(),
		channelId: text('channel_id')
			.notNull()
			.references(() => channels.id, { onDelete: 'cascade' }),
		scheduleLayerId: text('schedule_layer_id'),
		templateId: text('template_id').notNull(),
		slotId: text('slot_id').notNull(),
		programId: text('program_id'),
		mediaItemId: text('media_item_id'),
		role: text('role').$type<'primary' | 'filler' | 'dead-air'>().notNull(),
		title: text('title').notNull(),
		playbackPath: text('playback_path'),
		playbackParts: text('playback_parts', { mode: 'json' })
			.$type<Array<{ playbackPath: string; durationSeconds: number }>>()
			.notNull()
			.default([]),
		startsAt: text('starts_at').notNull(),
		finishesAt: text('finishes_at').notNull(),
		sourceStartSeconds: integer('source_start_seconds').notNull(),
		sourceFinishSeconds: integer('source_finish_seconds'),
		truncated: integer('truncated', { mode: 'boolean' }).notNull(),
		mediaSnapshot: text('media_snapshot', { mode: 'json' }).$type<
      (SchedulableMedia & { seriesTitle?: string | null }) | null
		>(),
		stateDelta: text('state_delta', { mode: 'json' }).$type<SelectionStateRecord[]>().notNull(),
	},
	(table) => [
		index('materialized_segments_channel_start_idx').on(table.channelId, table.startsAt),
		index('materialized_segments_channel_finish_idx').on(table.channelId, table.finishesAt),
	],
);

/**
 * Schema for `settings`.
 *
 * Stores application-wide playback settings by key.
 */
export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value', { mode: 'json' }).$type<PlaybackSettings>().notNull(),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});

/**
 * Stores the durable marker that closes unauthenticated first-run registration after either a local
 * or provider identity successfully initializes the installation.
 */
export const authenticationInitialization = sqliteTable(
	'authentication_initialization',
	{
		id: integer('id').primaryKey(),
		method: text('method').$type<'local' | 'logto'>().notNull(),
		initializedAt: text('initialized_at').notNull(),
	},
	(table) => [
		check('authentication_initialization_singleton', sql`${table.id} = 1`),
		check(
			'authentication_initialization_method',
			sql`${table.method} IN ('local', 'logto')`,
		),
	],
);

/** Full-access administrator identities established locally or by an external provider. */
export const authenticationIdentities = sqliteTable(
	'authentication_identities',
	{
		id: text('id').primaryKey(),
		provider: text('provider').$type<'local' | 'logto'>().notNull(),
		providerIssuer: text('provider_issuer'),
		providerSubject: text('provider_subject'),
		displayName: text('display_name').notNull(),
		username: text('username'),
		usernameKey: text('username_key'),
		passwordHash: text('password_hash'),
		...timestamps,
	},
	(table) => [
		uniqueIndex('authentication_identity_provider_subject').on(
			table.provider,
			table.providerIssuer,
			table.providerSubject,
		),
		uniqueIndex('authentication_identity_username_key').on(table.usernameKey),
		uniqueIndex('authentication_single_local_identity')
			.on(table.provider)
			.where(sql`${table.provider} = 'local'`),
		check(
			'authentication_identity_provider',
			sql`${table.provider} IN ('local', 'logto')`,
		),
	],
);

/** Revocable browser sessions stored by token hash rather than by bearer token. */
export const authenticationSessions = sqliteTable(
	'authentication_sessions',
	{
		tokenHash: text('token_hash').primaryKey(),
		identityId: text('identity_id')
			.notNull()
			.references(() => authenticationIdentities.id, { onDelete: 'cascade' }),
		csrfToken: text('csrf_token').notNull(),
		providerSessionId: text('provider_session_id'),
		providerLogoutHint: text('provider_logout_hint'),
		providerConfigurationHash: text('provider_configuration_hash'),
		createdAt: text('created_at').notNull(),
		lastSeenAt: text('last_seen_at').notNull(),
		expiresAt: text('expires_at').notNull(),
	},
	(table) => [
		index('authentication_sessions_identity_idx').on(table.identityId),
		index('authentication_sessions_provider_sid_idx').on(table.providerSessionId),
		index('authentication_sessions_expiry_idx').on(table.expiresAt),
	],
);

/** Short-lived, single-use state retained while a browser completes an OIDC redirect. */
export const authenticationOidcTransactions = sqliteTable(
	'authentication_oidc_transactions',
	{
		stateHash: text('state_hash').primaryKey(),
		bindingHash: text('binding_hash').notNull(),
		codeVerifier: text('code_verifier').notNull(),
		nonce: text('nonce').notNull(),
		returnTo: text('return_to').notNull(),
		logoutGeneration: integer('logout_generation').notNull().default(0),
		expiresAt: text('expires_at').notNull(),
	},
	(table) => [index('authentication_oidc_expiry_idx').on(table.expiresAt)],
);

/** Monotonic boundary used to reject OIDC callbacks crossed by a provider logout event. */
export const authenticationOidcLogoutGeneration = sqliteTable(
	'authentication_oidc_logout_generation',
	{
		id: integer('id').primaryKey(),
		generation: integer('generation').notNull(),
	},
);

/** Hashed, expiring provider logout identifiers retained to make delivery idempotent. */
export const authenticationOidcLogoutTokens = sqliteTable(
	'authentication_oidc_logout_tokens',
	{
		tokenHash: text('token_hash').primaryKey(),
		expiresAt: text('expires_at').notNull(),
	},
	(table) => [index('authentication_oidc_logout_expiry_idx').on(table.expiresAt)],
);

/** Hashed operator-issued codes that can create or recover the singleton local account. */
export const authenticationRecoveryTokens = sqliteTable(
	'authentication_recovery_tokens',
	{
		tokenHash: text('token_hash').primaryKey(),
		createdAt: text('created_at').notNull(),
		expiresAt: text('expires_at').notNull(),
	},
	(table) => [index('authentication_recovery_expiry_idx').on(table.expiresAt)],
);
