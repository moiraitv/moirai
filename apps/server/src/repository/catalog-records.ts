import type { MediaGroup, MediaItem, MediaItemDetail } from '@moirai/shared';

/** Joined media-item row before JSON columns are decoded. */
export interface RawItemRow {
	id: string;
	libraryId: string;
	groupId: string | null;
	stableKey: string;
	kind: string;
	title: string;
	sortTitle: string;
	relativePath: string;
	playbackPath: string;
	plot: string | null;
	year: number | null;
	durationSeconds: number | null;
	durationMilliseconds?: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	episodeEndNumber?: number | null;
	edition?: string | null;
	externalIds?: MediaItem['externalIds'] | string;
	trackNumber?: number | null;
	discNumber?: number | null;
	artists?: string[] | string;
	multipartStatus?: MediaItem['multipartStatus'];
	parts?: MediaItem['parts'] | string;
	subtitleTracks?: MediaItem['subtitleTracks'] | string;
	metadataStatus: MediaItem['metadataStatus'];
	availability: MediaItem['availability'];
	lastObservedAt: string | null;
	metadata: string | Record<string, unknown>;
	artworkRelativePath: string | null;
	fingerprint: string;
	fileModifiedAt: string | null;
	dateAddedAt: string;
	titleBucket: string;
	createdAt: string;
	updatedAt: string;
	sectionKey?: string | null;
	sectionLabel?: string | null;
}

/** Joined media-group row before JSON columns are decoded. */
export interface RawGroupRow {
	id: string;
	libraryId: string;
	parentId: string | null;
	kind: MediaGroup['kind'];
	title: string;
	sortTitle: string;
	year: number | null;
	plot: string | null;
	metadata: string | Record<string, unknown>;
	artworkRelativePath: string | null;
	childCount: number;
	parentTitle?: string | null;
	parentKind?: MediaGroup['kind'] | null;
}

/** Decode stored JSON metadata while preserving records already decoded by Drizzle. */
export function decodedMetadata(value: RawItemRow['metadata']): Record<string, unknown> {
	return typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : value;
}

/** Decode one JSON array column while accepting values already decoded by Drizzle. */
function decodedArray<T>(value: T[] | string | undefined): T[] {
	if (value === undefined) {
		return [];
	}
	return typeof value === 'string' ? JSON.parse(value) as T[] : value;
}

/** Read a metadata field as a sanitized list of strings. */
export function metadataStrings(metadata: Record<string, unknown>, key: string): string[] {
	const value = metadata[key];
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** Read a metadata field as one non-empty string. */
export function metadataString(metadata: Record<string, unknown>, key: string): string | null {
	const value = metadata[key];
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Read a metadata field as one finite number. */
export function metadataNumber(metadata: Record<string, unknown>, key: string): number | null {
	const value = metadata[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read persisted video width and height when both are valid. */
export function metadataResolution(
	metadata: Record<string, unknown>,
): MediaItemDetail['resolution'] {
	const value = metadata.resolution;
	if (!value || typeof value !== 'object') {
		return null;
	}

	const { width, height } = value as Record<string, unknown>;
	return typeof width === 'number'
		&& Number.isFinite(width)
		&& width > 0
		&& typeof height === 'number'
		&& Number.isFinite(height)
		&& height > 0
		? { width, height }
		: null;
}

/** Read a bounded list of measured codecs from persisted probe output. */
export function technicalCodecs(
	metadata: Record<string, unknown>,
	type: 'video' | 'audio',
): string[] {
	return Array.isArray(metadata.streams)
		? [...new Set(metadata.streams.flatMap((stream) => {
			if (!stream || typeof stream !== 'object') {
				return [];
			}

			const value = stream as Record<string, unknown>;
			return value.type === type && typeof value.codec === 'string' ? [value.codec] : [];
		}))]
		: [];
}

/** Derive the artwork cache version from source fingerprint metadata. */
export function cacheVersion(metadata: Record<string, unknown>, fallback: string): string {
	return typeof metadata.artworkFingerprint === 'string' ? metadata.artworkFingerprint : fallback;
}

/** Return a cache-versioned artwork proxy URL when the catalog record has source artwork. */
export function artworkUrl(
	kind: 'items' | 'groups',
	id: string,
	relativePath: string | null,
	version: string,
): string | null {
	return relativePath ? `/api/v1/artwork/${kind}/${id}?v=${encodeURIComponent(version)}` : null;
}

/** Build an API media item from a stored catalog row. */
export function mappedItem(row: RawItemRow): MediaItem {
	const metadata = decodedMetadata(row.metadata);
	return {
		id: row.id,
		libraryId: row.libraryId,
		groupId: row.groupId,
		kind: row.kind,
		title: row.title,
		sortTitle: row.sortTitle,
		relativePath: row.relativePath,
		playbackPath: row.playbackPath,
		plot: row.plot,
		year: row.year,
		durationSeconds: row.durationMilliseconds === null || row.durationMilliseconds === undefined
			? row.durationSeconds
			: row.durationMilliseconds / 1_000,
		seasonNumber: row.seasonNumber,
		episodeNumber: row.episodeNumber,
		episodeEndNumber: row.episodeEndNumber ?? null,
		edition: row.edition ?? null,
		externalIds: decodedArray(row.externalIds),
		trackNumber: row.trackNumber ?? null,
		discNumber: row.discNumber ?? null,
		artists: decodedArray(row.artists),
		multipartStatus: row.multipartStatus ?? 'none',
		parts: decodedArray(row.parts),
		subtitleTracks: decodedArray(row.subtitleTracks),
		metadataStatus: row.metadataStatus,
		availability: row.availability,
		lastObservedAt: row.lastObservedAt,
		metadata,
		artworkUrl: artworkUrl(
			'items',
			row.id,
			row.artworkRelativePath,
			cacheVersion(metadata, row.fingerprint),
		),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		fileModifiedAt: row.fileModifiedAt,
		dateAddedAt: row.dateAddedAt,
		titleBucket: row.titleBucket,
	};
}

/** Build an API media group from a stored catalog row. */
export function mappedGroup(row: RawGroupRow): MediaGroup {
	const metadata = decodedMetadata(row.metadata);
	return {
		id: row.id,
		libraryId: row.libraryId,
		parentId: row.parentId,
		kind: row.kind,
		title: row.title,
		sortTitle: row.sortTitle,
		year: row.year,
		yearEnd: typeof metadata.yearEnd === 'number' ? metadata.yearEnd : row.year,
		plot: row.plot,
		artworkUrl: artworkUrl(
			'groups',
			row.id,
			row.artworkRelativePath,
			cacheVersion(metadata, row.artworkRelativePath ?? row.id),
		),
		childCount: row.childCount,
	};
}
