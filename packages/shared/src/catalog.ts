import { z } from 'zod';
import type { MediaAvailability } from './availability.js';

/** Hierarchy kinds used to organize episodic and music-video libraries. */
export type MediaGroupKind = 'show' | 'season' | 'artist' | 'album';

/** Provider-scoped identifier discovered in a sidecar or portable filename tag. */
export interface MediaExternalId {
	provider: string;
	value: string;
	isDefault: boolean;
}

/** Stable inventory record for an embedded or sidecar subtitle track. */
export interface MediaSubtitleTrack {
	id: string;
	sourceType: 'embedded' | 'sidecar';
	partNumber: number | null;
	streamIndex: number | null;
	codec: string | null;
	format: string | null;
	language: string | null;
	title: string | null;
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired: boolean;
	isCommentary: boolean;
	relativePaths: string[];
	playbackPaths: string[];
}

/** One measured physical source that contributes to a logical media item. */
export interface MediaPart {
	number: number;
	kind: 'disc' | 'part' | 'cd' | 'dvd' | 'disk' | null;
	relativePath: string;
	playbackPath: string;
	durationSeconds: number | null;
	subtitleTracks: MediaSubtitleTrack[];
}

/** Validation state for a physical multipart sequence. */
export type MultipartStatus = 'none' | 'complete' | 'incomplete' | 'ambiguous';

/** Shared wire contract for a hierarchical media group. */
export interface MediaGroup {
	id: string;
	libraryId: string;
	parentId: string | null;
	kind: MediaGroupKind;
	title: string;
	sortTitle: string;
	year: number | null;
	yearEnd: number | null;
	plot: string | null;
	artworkUrl: string | null;
	childCount: number;
}

/** Shared wire contract for media item. */
export interface MediaItem {
	id: string;
	libraryId: string;
	groupId: string | null;
	kind: string;
	title: string;
	sortTitle: string;
	relativePath: string;
	playbackPath: string;
	plot: string | null;
	year: number | null;
	durationSeconds: number | null;
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
	availability: MediaAvailability;
	lastObservedAt: string | null;
	metadata: Record<string, unknown>;
	artworkUrl: string | null;
	createdAt: string;
	updatedAt: string;
	fileModifiedAt: string | null;
	dateAddedAt: string;
	titleBucket: string;
}

/** Validate the media sort contract at runtime. */
export const mediaSortSchema = z.enum(['title', 'date-added', 'genre']);
/** Validate the sort direction contract at runtime. */
export const sortDirectionSchema = z.enum(['asc', 'desc']);
/** Validate the genre match contract at runtime. */
export const genreMatchSchema = z.enum(['any', 'all']);
/** Shared wire contract for media sort. */
export type MediaSort = z.infer<typeof mediaSortSchema>;
/** Shared wire contract for sort direction. */
export type SortDirection = z.infer<typeof sortDirectionSchema>;
/** Shared wire contract for genre match. */
export type GenreMatch = z.infer<typeof genreMatchSchema>;

/** One item or hierarchy group returned by catalog browsing. */
export interface MediaBrowseEntry {
	key: string;
	kind: 'item' | 'group';
	navigationKey: string;
	sectionKey: string | null;
	sectionLabel: string | null;
	item: MediaItem | null;
	group: MediaGroup | null;
}

/** One catalog anchor and the first paginated result that contains it. */
export interface MediaNavigationOption {
	key: string;
	label: string;
	count: number;
	firstPage: number;
}

/** Paginated catalog entries and their contextual navigation anchors. */
export interface MediaBrowseResult {
	entries: MediaBrowseEntry[];
	groups: MediaGroup[];
	items: MediaItem[];
	pagination: {
		page: number;
		pageSize: number;
		totalEntries: number;
		totalPages: number;
	};
	navigation: MediaNavigationOption[];
}

/** Metadata field that caused a scheduling-source search match. */
export type MediaSourceMatchField
	= | 'title' | 'genre' | 'actor' | 'director' | 'show' | 'season' | 'artist' | 'album';

/** One reason a media source matched the picker search. */
export interface MediaSourceMatch {
	field: MediaSourceMatchField;
	label: string;
}

/** Catalog entry with the metadata fields that matched source-picker search. */
export type MediaSourcePickerEntry = MediaBrowseEntry & {
	matches: MediaSourceMatch[];
};

/** Bounded source-picker results for scheduling program configuration. */
export interface MediaSourcePickerResult {
	entries: MediaSourcePickerEntry[];
	pagination: MediaBrowseResult['pagination'];
}

/** One normalized genre and its indexed item count. */
export interface MediaGenreFacet {
	key: string;
	name: string;
	count: number;
}

/** Credited person associated with an indexed media item. */
export interface MediaPerson {
	name: string;
	role: string | null;
	sortOrder: number | null;
}

/** Full media detail including credits and measured playback facts. */
export interface MediaItemDetail extends MediaItem {
	genres: string[];
	directors: string[];
	actors: MediaPerson[];
	writers: string[];
	studios: string[];
	countries: string[];
	certification: string | null;
	rating: number | null;
	resolution: { width: number; height: number } | null;
	fileSizeBytes: number | null;
	container: string | null;
	videoCodecs: string[];
	audioCodecs: string[];
	probeStatus: 'pending' | 'complete' | 'failed';
	probeUpdatedAt: string | null;
	probeErrorCode: string | null;
	groupTrail: Array<{ id: string; kind: MediaGroupKind; title: string }>;
}

/** User-visible collision that needs review without silently discarding data. */
export interface DataConflict {
	id: string;
	kind: 'show-external-id' | 'resource-name' | 'channel-number';
	severity: 'warning' | 'error';
	resourceType: 'library' | 'program' | 'template' | 'channel';
	resourceId: string | null;
	libraryId: string | null;
	title: string;
	message: string;
	paths: string[];
	observedAt: string | null;
}

/** Bounded conflict report displayed by system status. */
export interface DataConflictReport {
	conflicts: DataConflict[];
	truncated: boolean;
}
