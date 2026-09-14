import { canonicalIdentityKey } from '@moirai/shared';
import type { mediaGroups } from '../db/schema.js';
import type { DiscoveredGroup, DiscoveredItem } from './contracts.js';

/** Stored owner and insertion order used to preserve the previous first-match semantics. */
interface IndexedOwner {
	row: typeof mediaGroups.$inferSelect;
	position: number;
	buckets: Set<IndexedOwner>[];
}

/** Index an owner in insertion order and retain the bucket for constant-time claim removal. */
function indexOwner(index: Map<string, Set<IndexedOwner>>, key: string, owner: IndexedOwner): void {
	const bucket = index.get(key) ?? new Set<IndexedOwner>();
	bucket.add(owner);
	index.set(key, bucket);
	owner.buckets.push(bucket);
}

/** Include the parent owner and group kind so same-named albums remain distinct. */
function fallbackKey(kind: string, parentId: string | null, title: string): string {
	return JSON.stringify([kind, parentId, canonicalIdentityKey(title)]);
}

/** Preserve music program references when metadata groups acquire matching filesystem folders. */
export function preserveMusicGroupIdentities(
	groups: DiscoveredGroup[],
	items: DiscoveredItem[],
	existingGroups: Array<typeof mediaGroups.$inferSelect>,
): void {
	const replacements = new Map<string, string>();
	const discoveredIds = new Set(groups.map(group => group.id));
	const byId = new Map<string, IndexedOwner>();
	const bySource = new Map<string, Set<IndexedOwner>>();
	const byIdentity = new Map<string, Set<IndexedOwner>>();
	const metadataByIdentity = new Map<string, Set<IndexedOwner>>();

	// Index eligible owners once; claimed owners are removed from all lookup buckets.
	for (const [position, row] of existingGroups.entries()) {
		if (row.kind !== 'artist' && row.kind !== 'album') {
			continue;
		}
		const owner: IndexedOwner = { row, position, buckets: [] };
		byId.set(row.id, owner);
		indexOwner(bySource, JSON.stringify([row.kind, row.sourceKey]), owner);
		if (!discoveredIds.has(row.id)) {
			const key = fallbackKey(row.kind, row.parentId, row.title);
			indexOwner(byIdentity, key, owner);
			if (row.stableKey.startsWith('music-')) {
				indexOwner(metadataByIdentity, key, owner);
			}
		}
	}


	// Resolve artists before albums so album identity includes the preserved artist owner.
	for (const kind of ['artist', 'album'] as const) {
		for (const group of groups.filter(group => group.kind === kind)) {
			const originalId = group.id;
			const parentId = group.parentId ? replacements.get(group.parentId) ?? group.parentId : null;
			const sourceKey = group.sourceKey ?? group.stableKey;
			const idOwner = byId.get(originalId);
			const matchingId = idOwner?.row.kind === kind ? idOwner : undefined;
			const sourceOwner = bySource.get(JSON.stringify([kind, sourceKey]))?.values().next().value;
			const exact = matchingId && sourceOwner
				? (matchingId.position < sourceOwner.position ? matchingId : sourceOwner)
				: matchingId ?? sourceOwner;
			const identityIndex = group.stableKey.startsWith('music-') ? byIdentity : metadataByIdentity;
			const candidates = exact ? undefined : identityIndex.get(fallbackKey(kind, parentId, group.title));
			const owner = exact ?? (candidates?.size === 1 ? candidates.values().next().value : undefined);
			if (owner) {
				replacements.set(originalId, owner.row.id);
				group.id = owner.row.id;
				group.stableKey = owner.row.stableKey;
				byId.delete(owner.row.id);
				for (const bucket of owner.buckets) {
					bucket.delete(owner);
				}
			}
			group.parentId = parentId;
		}
	}

	// Keep song membership attached to the reconciled album identifiers.
	for (const item of items) {
		if (item.groupId) {
			item.groupId = replacements.get(item.groupId) ?? item.groupId;
		}
	}
}
