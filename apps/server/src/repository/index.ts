import { audioMetadata } from './audio-metadata.js';
import { EncodingProfileRepository } from './encoding-profiles.js';
import { sql } from 'drizzle-orm';
import { CreditTemplateRepository } from './credit-templates.js';
import type {
	Channel,
	ChannelCreate,
	ChannelSchedule,
	ChannelScheduleConfig,
	ChannelUpdate,
	LibraryContentPreview,
	MediaGroup,
	MediaBrowseResult,
	MediaCardPreview,
	MediaGenreFacet,
	MediaItem,
	MediaItemDetail,
	MediaSourcePickerResult,
	PlaybackSettings,
	ProgramCreate,
	ProgramUpdate,
	QuickChannelSetupCreate,
	CatalogProgramItemQuery,
	ScheduleTemplate,
	ScheduleTemplateCreate,
	ScheduleTemplateUpdate,
	SchedulingCatalog,
	SchedulingProgram,
	SelectionStateRecord,
	ChannelTimelineMaterializationStatus,
	DataConflictReport,
	ViewingPreferenceScores,
	ViewingPreferenceSummary,
} from '@moirai/shared';
import type { QuickChannelSetupResult } from '@moirai/shared/api-contracts';
import type { MoiraiDatabase } from '../db/index.js';
import { MediaCatalogRepository } from './catalog.js';
import { AuthenticationRepository } from './authentication.js';
import { ChannelRepository } from './channels.js';
import { SchedulingRepository } from './scheduling.js';
import { SettingsRepository } from './settings.js';
import { ViewingPreferenceRepository } from './viewing-preferences.js';
import { LibraryRepository } from './libraries.js';
import { QuickChannelSetupRepository } from './quick-channel-setups.js';
import { listDataConflicts } from './conflicts.js';
import type {
	MediaBrowseQuery,
	MediaFileOwner,
	MediaGenreFacetSelection,
	MediaProbeCacheEntry,
	MediaSourcePickerQuery,
	ProgramItemAppendResult,
	ProgramItemSelection,
	TimelineCommit,
	TimelineMaterializationRecord,
	MaterializedSegmentRecord,
} from './contracts.js';

export type {
	CatalogConflictObservation,
	DiscoveredGroup,
	DiscoveredItem,
	MaterializedSegmentRecord,
	MediaBrowseQuery,
	MediaFileOwner,
	MediaProbeCacheEntry,
	MissingItemPresenceBatch,
	ReconciledPresenceCheck,
	MediaSourcePickerQuery,
	ScanHistoryRetention,
	ReconciledScan,
	TimelineCommit,
	TimelineMaterializationRecord,
} from './contracts.js';

/**
 * Serve as the application's single persistence facade for libraries, scans, catalog data, channels,
 * scheduling, and playback settings. It composes focused repository domains over one database while
 * centralizing catalog invalidation and cross-domain queries for service callers.
 */
export class Repository extends LibraryRepository {
	/** Read indexed audio streams for referenced physical files in bounded batches. */
	audioMetadata(ids: string[]): Promise<Map<string, unknown>> {
		return audioMetadata(this.database, ids);
	}

	/** Reusable audio/video profiles and linked channel settings. */
	readonly encodingProfiles: EncodingProfileRepository;
	/** Reusable credit templates and subtitle playback metadata. */
	readonly creditTemplates: CreditTemplateRepository;
	/** Authentication persistence exposed to the cross-cutting authentication service. */
	readonly authentication: AuthenticationRepository;
	private readonly catalog: MediaCatalogRepository;
	private readonly channels: ChannelRepository;
	private readonly scheduling: SchedulingRepository;
	private readonly settings: SettingsRepository;
	private readonly quickChannelSetups: QuickChannelSetupRepository;
	private readonly viewingPreferences: ViewingPreferenceRepository;

	constructor(private readonly database: MoiraiDatabase) {
		super(database);
		this.authentication = new AuthenticationRepository(database);
		this.encodingProfiles = new EncodingProfileRepository(database);
		this.creditTemplates = new CreditTemplateRepository(database);
		this.catalog = new MediaCatalogRepository(database);
		this.channels = new ChannelRepository(database);
		this.scheduling = new SchedulingRepository(database);
		this.settings = new SettingsRepository(database);
		this.quickChannelSetups = new QuickChannelSetupRepository(database);
		this.viewingPreferences = new ViewingPreferenceRepository(database);
	}

	/** Run the smallest SQLite query used to verify database readiness. */
	checkDatabase(): void {
		this.database.run(sql`SELECT 1`);
	}

	/** Return source and resource-identity conflicts that require user review. */
	async listDataConflicts(): Promise<DataConflictReport> {
		return listDataConflicts(this.database);
	}

	/** Return artwork owners that still exist in the indexed library. */
	async existingArtworkOwnerIds(
		libraryId: string,
		kind: 'items' | 'groups',
		ownerIds: string[],
	): Promise<Set<string>> {
		return this.catalog.existingArtworkOwnerIds(libraryId, kind, ownerIds);
	}

	/** Delegate a catalog browse query to the focused catalog repository. */
	async browseMedia(libraryId: string, query: MediaBrowseQuery): Promise<MediaBrowseResult> {
		return this.catalog.browseMedia(libraryId, query);
	}

	/** Resolve recursive filtered media identifiers for a selected-items program operation. */
	resolveProgramItemSelection(
		libraryId: string,
		query: CatalogProgramItemQuery,
		maxItemCount?: number,
	): ProgramItemSelection {
		return this.catalog.resolveProgramItemSelection(libraryId, query, maxItemCount);
	}

	/** Return bounded media choices for the program source picker. */
	async browseMediaSourceOptions(
		libraryId: string,
		query: MediaSourcePickerQuery,
	): Promise<MediaSourcePickerResult> {
		return this.catalog.browseMediaSourceOptions(libraryId, query);
	}

	/** List genre facets with optional counts for required and disallowed Match all actions. */
	async listMediaGenres(
		libraryId: string,
		selection: MediaGenreFacetSelection | null = null,
	): Promise<MediaGenreFacet[]> {
		return this.catalog.listMediaGenres(libraryId, selection);
	}

	/** Resolve selected media in request order with canonical or authored response identifiers. */
	async listMediaItemsByIds(
		libraryId: string,
		itemIds: string[],
		identity: 'canonical' | 'requested' = 'canonical',
	): Promise<MediaItem[]> {
		return this.catalog.listMediaItemsByIds(libraryId, itemIds, identity);
	}

	/** Return successful probe data used to avoid reopening unchanged media files. */
	async listMediaProbeCache(libraryId: string): Promise<MediaProbeCacheEntry[]> {
		return this.catalog.listMediaProbeCache(libraryId);
	}

	/** Return whether an enabled library still contains unprobed media. */
	async libraryNeedsMediaProbe(libraryId: string): Promise<boolean> {
		return this.catalog.libraryNeedsMediaProbe(libraryId);
	}

	/** Collect the stable identifiers for list media groups by. */
	async listMediaGroupsByIds(libraryId: string, groupIds: string[]): Promise<MediaGroup[]> {
		return this.catalog.listMediaGroupsByIds(libraryId, groupIds);
	}

	/** Return a media item's full catalog detail, if it still exists. */
	async getMediaItem(id: string): Promise<MediaItemDetail | null> {
		return this.catalog.getMediaItem(id);
	}

	/** Return bounded indexed metadata for a compact media-card preview. */
	async getMediaCardPreview(id: string): Promise<MediaCardPreview | null> {
		return this.catalog.getMediaCardPreview(id);
	}

	/** Return bounded recently indexed media grouped for every library overview row. */
	listLibraryContentPreviews(): LibraryContentPreview[] {
		return this.catalog.listLibraryContentPreviews();
	}

	/** Return the library source location that owns a media item. */
	async getMediaFileOwner(id: string): Promise<MediaFileOwner | null> {
		return this.catalog.getMediaFileOwner(id);
	}

	/** Return the source artwork location for a catalog item or group. */
	async getArtworkOwner(kind: 'items' | 'groups', id: string) {
		return this.catalog.getArtworkOwner(kind, id);
	}

	/** List channels in channel-number order. */
	async listChannels(): Promise<Channel[]> {
		return this.channels.listChannels();
	}

	/** Return a channel by identifier. */
	async getChannel(id: string): Promise<Channel | null> {
		return this.channels.getChannel(id);
	}

	/** Return a channel by its canonicalized public number. */
	async getChannelByNumber(number: string): Promise<Channel | null> {
		return this.channels.getChannelByNumber(number);
	}

	/** Create a channel with its stable Moirai XMLTV identifier. */
	async createChannel(input: ChannelCreate, useDefaultProfile = false): Promise<Channel> {
		return this.channels.createChannel(input, useDefaultProfile);
	}

	/** Merge channel changes and refresh the derived Moirai XMLTV identifier. */
	async updateChannel(id: string, input: ChannelUpdate): Promise<Channel | null> {
		return this.channels.updateChannel(id, input);
	}

	/** Replace only the logo reference using a channel already fetched by the request. */
	async updateChannelLogo(channel: Channel, logo: string | null): Promise<Channel> {
		return this.channels.updateChannelLogo(channel, logo);
	}

	/** Remove a channel and report whether it existed. */
	async deleteChannel(id: string): Promise<boolean> {
		return this.channels.deleteChannel(id);
	}

	/** Build validated sample resources without persistence or scheduling invalidation. */
	previewQuickChannelSetup(
		input: QuickChannelSetupCreate,
		maxExplicitMediaItems: number,
	): QuickChannelSetupResult {
		return this.quickChannelSetups.preview(input, maxExplicitMediaItems);
	}

	/** Atomically create the core resources for one simple playable channel. */
	createQuickChannelSetup(
		input: QuickChannelSetupCreate,
		maxExplicitMediaItems: number,
	): QuickChannelSetupResult {
		const result = this.quickChannelSetups.create(input, maxExplicitMediaItems);
		this.scheduling.invalidateSchedulingCatalog();
		return result;
	}

	/** List reusable scheduling programs. */
	async listPrograms(): Promise<SchedulingProgram[]> {
		return this.scheduling.listPrograms();
	}

	/** Return one reusable scheduling program. */
	async getProgram(id: string): Promise<SchedulingProgram | null> {
		return this.scheduling.getProgram(id);
	}

	/** Persist a reusable scheduling program. */
	async createProgram(input: ProgramCreate): Promise<SchedulingProgram> {
		return this.scheduling.createProgram(input);
	}

	/** Replace a program configuration while preserving its identity. */
	async updateProgram(id: string, input: ProgramUpdate): Promise<SchedulingProgram | null> {
		return this.scheduling.updateProgram(id, input);
	}

	/** Append canonical item identifiers to one compatible selected-items program atomically. */
	appendProgramItems(
		id: string,
		libraryId: string,
		itemIds: string[],
		confirmedAdditionToken?: string,
		maxItemCount?: number,
	): ProgramItemAppendResult {
		const result = this.scheduling.appendProgramItems(
			id,
			libraryId,
			itemIds,
			confirmedAdditionToken,
			maxItemCount,
		);
		if (result.status === 'updated' && result.changed) {
			this.scheduling.invalidateSchedulingCatalog();
		}

		return result;
	}

	/** Delete a program when no scheduling configuration references it. */
	async deleteProgram(id: string): Promise<boolean> {
		return this.scheduling.deleteProgram(id);
	}

	/** List authored daily schedule templates. */
	async listScheduleTemplates(): Promise<ScheduleTemplate[]> {
		return this.scheduling.listScheduleTemplates();
	}

	/** Return one authored daily schedule template. */
	async getScheduleTemplate(id: string): Promise<ScheduleTemplate | null> {
		return this.scheduling.getScheduleTemplate(id);
	}

	/** Persist a new daily schedule template. */
	async createScheduleTemplate(input: ScheduleTemplateCreate): Promise<ScheduleTemplate> {
		return this.scheduling.createScheduleTemplate(input);
	}

	/** Replace an existing daily schedule template. */
	async updateScheduleTemplate(
		id: string,
		input: ScheduleTemplateUpdate,
	): Promise<ScheduleTemplate | null> {
		return this.scheduling.updateScheduleTemplate(id, input);
	}

	/** Delete a template when no channel schedule references it. */
	async deleteScheduleTemplate(id: string): Promise<boolean> {
		return this.scheduling.deleteScheduleTemplate(id);
	}

	/** Return the layered schedule assigned to a channel. */
	async getChannelSchedule(channelId: string): Promise<ChannelSchedule | null> {
		return this.scheduling.getChannelSchedule(channelId);
	}

	/** List every configured channel schedule. */
	async listChannelSchedules(): Promise<ChannelSchedule[]> {
		return this.scheduling.listChannelSchedules();
	}

	/** Persist a channel's base and conditional template stack. */
	async setChannelSchedule(
		channelId: string,
		config: ChannelScheduleConfig,
	): Promise<ChannelSchedule | null> {
		return this.scheduling.setChannelSchedule(channelId, config);
	}

	/** Delete a channel's authored schedule and generated playback state. */
	async deleteChannelSchedule(channelId: string): Promise<boolean> {
		return this.scheduling.deleteChannelSchedule(channelId);
	}

	/** Make a template the base schedule for exactly the supplied channels. */
	async setTemplateAssignments(
		templateId: string,
		channelIds: string[],
	): Promise<ChannelSchedule[]> {
		return this.scheduling.setTemplateAssignments(templateId, channelIds);
	}

	/** Discard cached scheduling catalog scopes after index changes. */
	protected catalogChanged(): void {
		this.invalidateSchedulingCatalog();
	}

	/** Discard cached scheduling catalog scopes after index changes. */
	invalidateSchedulingCatalog(): void {
		this.scheduling.invalidateSchedulingCatalog();
	}

	/** Load the smallest catalog scope needed by the requested programs. */
	async getSchedulingCatalog(
		programs?: SchedulingProgram[],
		rootProgramIds?: Iterable<string>,
	): Promise<SchedulingCatalog> {
		return this.scheduling.getSchedulingCatalog(programs, rootProgramIds);
	}

	/** Load persistent program cursors for one channel. */
	async getSelectionState(channelId: string): Promise<SelectionStateRecord[]> {
		return this.scheduling.getSelectionState(channelId);
	}

	/** Load persistent program cursors grouped by channel. */
	async getSelectionStatesByChannel(): Promise<Map<string, SelectionStateRecord[]>> {
		return this.scheduling.getSelectionStatesByChannel();
	}

	/** Return the committed timeline window for one channel. */
	async getTimelineMaterialization(
		channelId: string,
	): Promise<TimelineMaterializationRecord | null> {
		return this.scheduling.getTimelineMaterialization(channelId);
	}

	/** Return timeline health even when no successful timeline has been committed. */
	async getTimelineMaterializationStatus(
		channelId: string,
	): Promise<ChannelTimelineMaterializationStatus | null> {
		return this.scheduling.getTimelineMaterializationStatus(channelId);
	}

	/** List materialization health and pending state for all channels. */
	async listTimelineMaterializationStatuses(): Promise<ChannelTimelineMaterializationStatus[]> {
		return this.scheduling.listTimelineMaterializationStatuses();
	}

	/** List committed timeline windows for all channels. */
	async listTimelineMaterializations(): Promise<TimelineMaterializationRecord[]> {
		return this.scheduling.listTimelineMaterializations();
	}

	/** Read committed timeline segments overlapping a time range. */
	async listMaterializedTimelineSegments(
		rangeStart: string,
		rangeEnd: string,
		channelId?: string,
	): Promise<MaterializedSegmentRecord[]> {
		return this.scheduling.listMaterializedTimelineSegments(rangeStart, rangeEnd, channelId);
	}

	/** Read a chronologically bounded committed range for combined guide responses. */
	async listMaterializedTimelineSegmentsForGuide(
		rangeStart: string,
		rangeEnd: string,
		limit: number,
	): Promise<MaterializedSegmentRecord[]> {
		return this.scheduling.listMaterializedTimelineSegmentsForGuide(rangeStart, rangeEnd, limit);
	}

	/** Return one committed timeline segment scoped to its owning channel. */
	async getMaterializedTimelineSegment(
		channelId: string,
		segmentId: string,
	): Promise<MaterializedSegmentRecord | null> {
		return this.scheduling.getMaterializedTimelineSegment(channelId, segmentId);
	}

	/** Mark channels for regeneration after a coalescing deadline. */
	markTimelinePending(channelIds: string[], applyAfter: string, pendingSince: string): void {
		this.scheduling.markTimelinePending(channelIds, applyAfter, pendingSince);
	}

	/** Record a failed materialization without discarding its prior timeline. */
	markTimelineFailed(channelId: string, message: string, failedAt: string): void {
		this.scheduling.markTimelineFailed(channelId, message, failedAt);
	}

	/** Atomically commit a generated timeline tail and its final selection checkpoint. */
	commitMaterializedTimeline(input: TimelineCommit): void {
		this.scheduling.commitMaterializedTimeline(input);
	}

	/** Return persisted playback settings or safe defaults. */
	async getPlaybackSettings(): Promise<PlaybackSettings> {
		return this.settings.getPlaybackSettings();
	}

	/** Persist validated playback settings. */
	async setPlaybackSettings(value: PlaybackSettings): Promise<PlaybackSettings> {
		return this.settings.setPlaybackSettings(value);
	}

	/** Persist one qualified anonymous media encounter. */
	recordViewingPreference(
		mediaItemId: string,
		points: 1 | 2,
		encounterType: 'initial' | 'continued',
		occurredAt: string,
	): void {
		this.viewingPreferences.recordViewingPreference(
			mediaItemId,
			points,
			encounterType,
			occurredAt,
		);
	}

	/** Return the current decayed viewing-preference score snapshot. */
	viewingPreferenceScores(asOf: string): ViewingPreferenceScores {
		return this.viewingPreferences.viewingPreferenceScores(asOf);
	}

	/** List the strongest current learned preferences. */
	listViewingPreferences(asOf: string, limit: number): ViewingPreferenceSummary[] {
		return this.viewingPreferences.listViewingPreferences(asOf, limit);
	}

	/** Remove all learned viewing preferences. */
	clearViewingPreferences(): void {
		this.viewingPreferences.clearViewingPreferences();
	}

	/** Prune expired or orphaned viewing-preference events. */
	pruneViewingPreferences(cutoff: string): void {
		this.viewingPreferences.pruneViewingPreferences(cutoff);
	}
}
