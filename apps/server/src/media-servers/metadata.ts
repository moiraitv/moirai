import { MAX_METADATA_LIST_ITEMS, MAX_METADATA_PEOPLE_ITEMS, MAX_METADATA_TEXT_LENGTH, type MediaPerson } from '@moirai/shared';
import { normalizedReleaseDate } from '../media/release-date.js';
import { normalizePeople, normalizeSearchText } from '../scanner/catalog-metadata.js';
import type { RemoteMediaItem } from './items.js';

/** Keep provider display text within the same bounds as sidecar metadata. */
export function remoteMetadataText(value: unknown): string | null {
	return typeof value === 'string' ? value.trim().slice(0, MAX_METADATA_TEXT_LENGTH) || null : null;
}

/** Preserve authored spelling and order while deduplicating bounded metadata labels. */
function labels(value: unknown, limit = MAX_METADATA_LIST_ITEMS): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const unique = new Map<string, string>();
	for (const entry of value) {
		const name = remoteMetadataText(entry);
		if (name && !unique.has(normalizeSearchText(name))) {
			unique.set(normalizeSearchText(name), name);
			if (unique.size === limit) {
				break;
			}
		}
	}
	return [...unique.values()];
}

/** Retain finite provider ratings only when they use the catalog's 0–10 scale. */
function rating(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
}

/** Keep actor identity separate from character names and retain valid source billing values. */
function actors(value: unknown): MediaPerson[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const credits = value.slice(0, MAX_METADATA_PEOPLE_ITEMS).flatMap<MediaPerson>((entry: unknown) => {
		if (!entry || typeof entry !== 'object' || !('name' in entry)) {
			return [];
		}

		const person = entry as Record<string, unknown>;
		const name = remoteMetadataText(person.name);
		return name ? [{
			name,
			role: remoteMetadataText(person.role),
			sortOrder: typeof person.sortOrder === 'number' && Number.isSafeInteger(person.sortOrder) && person.sortOrder >= 0
				? person.sortOrder : null,
		}] : [];
	});
	return normalizePeople([], credits).map(({ name, role, sortOrder }) => ({ name, role, sortOrder }));
}

/** Supply the common metadata consumed by SQL filters, scheduling, details, guides, and graphics. */
export function remoteCatalogMetadata(item: RemoteMediaItem) {
	const metadata = item.metadata;
	return {
		actors: actors(item.actors),
		directors: labels(item.directors, MAX_METADATA_PEOPLE_ITEMS),
		genres: labels(item.genres),
		artists: labels(item.artists, MAX_METADATA_PEOPLE_ITEMS),
		album: remoteMetadataText(item.album),
		edition: remoteMetadataText(metadata?.edition),
		originalTitle: remoteMetadataText(metadata?.originalTitle),
		releaseDate: normalizedReleaseDate(metadata?.releaseDate),
		rating: rating(metadata?.rating),
		userRating: rating(metadata?.userRating),
		certification: remoteMetadataText(metadata?.certification),
		writers: labels(metadata?.writers, MAX_METADATA_PEOPLE_ITEMS),
		studio: labels(metadata?.studios),
		countries: labels(metadata?.countries),
		tags: labels(metadata?.tags),
	};
}
