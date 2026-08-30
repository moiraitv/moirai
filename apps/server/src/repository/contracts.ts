import type {
	ChannelTimelineMaterializationStatus,
	MediaExternalId,
	MediaPart,
	MediaSort,
	MediaSubtitleTrack,
	MultipartStatus,
	ScanRun,
	SchedulableMedia,
	SelectionStateRecord,
	TimelineIssue,
	TimelineSegment,
} from '@moirai/shared';
import type { MissingItemPresenceTarget } from '../scanner/contracts.js';

/** Filters, ordering, and paging accepted by catalog browsing. */
export interface MediaBrowseQuery {
	parentId: string | null;
	page: number;
	pageSize: number;
	sort: MediaSort;
	direction: 'asc' | 'desc';
	name: string;
	releaseYearFrom: number | null;
	releaseYearTo: number | null;
	addedFrom: string | null;
	addedBefore: string | null;
	genres: string[];
	excludedGenres: string[];
	genreMatch: 'any' | 'all';
	actor: string;
	director: string;
}

/** Required and disallowed genre rules used to predict Match all facet actions. */
export interface MediaGenreFacetSelection {
	genres: string[];
	excludedGenres: string[];
}

/** Source location needed to resolve a playable media file. */
export interface MediaFileOwner {
	libraryId: string;
	relativePath: string;
	sourceType: string;
	scanRoot: string;
}

/** Completed scan together with media records removed during reconciliation. */
export interface ReconciledScan extends ScanRun {
	removedItemIds: string[];
}

/** Age and per-library count limits for completed scan records. */
export interface ScanHistoryRetention {
	scanDays: number;
	scansPerLibrary: number;
}

/** Current removal revision and its provider-facing targeted presence work. */
export interface MissingItemPresenceBatch {
	revision: string;
	nextCheckAt: string;
	mode: 'confirmation' | 'heal-only';
	targets: MissingItemPresenceTarget[];
}

/** Atomic result of applying a targeted presence observation to current tombstones. */
export interface ReconciledPresenceCheck {
	applied: boolean;
	changed: boolean;
	removedItemIds: string[];
	presentItemIds: string[];
	restoredItemIds: string[];
	pendingRemovalCount: number;
}

/** Bounded catalog query used by program source pickers. */
export interface MediaSourcePickerQuery {
	target: 'items' | 'groups';
	parentId: string | null;
	page: number;
	pageSize: number;
	search: string;
}

/** Persisted timeline window and the state checkpoint used to continue it. */
export interface TimelineMaterializationRecord extends ChannelTimelineMaterializationStatus {
	windowStart: string;
	windowEnd: string;
	committedAt: string;
	continuationAt: string;
	inputFingerprint: string;
	baseState: SelectionStateRecord[];
	issues: TimelineIssue[];
}

/** Timeline segment with the media and cursor state captured at generation time. */
export interface MaterializedSegmentRecord {
	segment: TimelineSegment;
	mediaSnapshot: (SchedulableMedia & { seriesTitle?: string | null }) | null;
	stateDelta: SelectionStateRecord[];
}

/** Atomic replacement of a channel timeline window and its continuation state. */
export interface TimelineCommit {
	channelId: string;
	windowStart: string;
	windowEnd: string;
	replaceFrom: string;
	continuationAt: string;
	inputFingerprint: string;
	baseState: SelectionStateRecord[];
	finalState: SelectionStateRecord[];
	segments: MaterializedSegmentRecord[];
	issues: TimelineIssue[];
	committedAt: string;
}

/** Hierarchical media metadata normalized by a library source adapter. */
export interface DiscoveredGroup {
	id: string;
	stableKey: string;
	sourceKey?: string;
	parentId: string | null;
	kind: 'show' | 'season' | 'artist' | 'album';
	title: string;
	sortTitle: string;
	year: number | null;
	plot: string | null;
	metadata: Record<string, unknown>;
	artworkRelativePath: string | null;
}

/** Source-level identity conflict observed during a healthy catalog scan. */
export interface CatalogConflictObservation {
	conflictKey: string;
	kind: 'show-external-id';
	provider: string;
	externalId: string;
	paths: string[];
	message: string;
}

/** Playable media and normalized metadata discovered by a library source adapter. */
export interface DiscoveredItem {
	id: string;
	aliasIds: string[];
	groupId: string | null;
	stableKey: string;
	kind: string;
	title: string;
	sortTitle: string;
	relativePath: string;
	playbackPath: string;
	nfoRelativePath: string | null;
	plot: string | null;
	year: number | null;
	durationMilliseconds: number | null;
	probeFingerprint: string;
	probeStatus: 'complete' | 'failed';
	probeUpdatedAt: string;
	probeErrorCode: string | null;
	technicalMetadata: Record<string, unknown>;
	seasonNumber: number | null;
	episodeNumber: number | null;
	episodeEndNumber: number | null;
	edition: string | null;
	externalIds: MediaExternalId[];
	trackNumber: number | null;
	discNumber: number | null;
	artists: string[];
	multipartStatus: MultipartStatus;
	parts: MediaPart[];
	subtitleTracks: MediaSubtitleTrack[];
	metadataStatus: 'complete' | 'incomplete' | 'invalid';
	metadata: Record<string, unknown>;
	artworkRelativePath: string | null;
	fingerprint: string;
	fileModifiedAt: string;
	titleBucket: string;
	genres: Array<{ key: string; name: string }>;
	people: Array<{
		personType: 'actor' | 'director';
		name: string;
		normalizedName: string;
		role: string | null;
		sortOrder: number | null;
	}>;
}

/** Successful technical probe cached for an unchanged indexed media file. */
export interface MediaProbeCacheEntry {
	relativePath: string;
	probeFingerprint: string | null;
	durationMilliseconds: number | null;
	probeStatus: 'pending' | 'complete' | 'failed';
	probeUpdatedAt: string | null;
	probeErrorCode: string | null;
	technicalMetadata: Record<string, unknown>;
}
