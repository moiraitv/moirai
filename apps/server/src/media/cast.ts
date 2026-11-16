import { MAX_METADATA_PEOPLE_ITEMS, TOP_BILLED_ACTOR_COUNT, type CatalogDisplayMetadata, type MediaPerson } from '@moirai/shared';
import { normalizePeople, normalizeSearchText } from '../scanner/catalog-metadata.js';

/** Deduplicate cast in billing order, retaining source order for tied or missing billing values. */
export function orderedCast(value: unknown): CatalogDisplayMetadata['cast'] {
	if (!Array.isArray(value)) {
		return [];
	}

	const credits = value.slice(0, MAX_METADATA_PEOPLE_ITEMS).flatMap<MediaPerson>((entry: unknown) => {
		if (typeof entry === 'string' && entry.trim()) {
			return [{ name: entry, role: null, sortOrder: null }];
		}
		if (!entry || typeof entry !== 'object' || !('name' in entry) || typeof entry.name !== 'string') {
			return [];
		}

		const credit = entry as Record<string, unknown>;
		return [{
			name: entry.name,
			role: typeof credit.role === 'string' && credit.role.length > 0 ? credit.role : null,
			sortOrder: typeof credit.sortOrder === 'number' && Number.isFinite(credit.sortOrder) ? credit.sortOrder : null,
		}];
	});
	return normalizePeople([], credits)
		.sort((left, right) => (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER))
		.map(({ name, role }) => ({ name, role }));
}

/** Match an actor's partial name within the first ordered cast credits. */
export function topBilledActorMatches(cast: CatalogDisplayMetadata['cast'], query: string): boolean {
	const normalizedQuery = normalizeSearchText(query);
	return cast.slice(0, TOP_BILLED_ACTOR_COUNT)
		.some(({ name }) => normalizeSearchText(name).includes(normalizedQuery));
}
