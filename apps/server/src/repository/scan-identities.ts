import type { mediaGroups } from '../db/schema.js';
import type { DiscoveredGroup, DiscoveredItem } from './contracts.js';

/**
 * Preserve group IDs when an indexed source folder can be matched unambiguously.
 *
 * Stable group ownership keeps authored scheduling references intact when improved metadata changes
 * a show's derived identity.
 */
export function preserveGroupIdentities(
	groups: DiscoveredGroup[],
	items: DiscoveredItem[],
	existingGroups: Array<typeof mediaGroups.$inferSelect>,
	existingItems: Array<{ relativePath: string; groupId: string | null }>,
): void {
	// Associate existing groups with their observed top-level source folders.
	const groupById = new Map(existingGroups.map((group) => [group.id, group]));
	const foldersByGroup = new Map<string, Set<string>>();
	for (const item of existingItems) {
		if (!item.groupId) {
			continue;
		}

		const folder = item.relativePath.split('/')[0];
		if (!folder) {
			continue;
		}

		let groupId: string | null = item.groupId;
		while (groupId) {
			const folders = foldersByGroup.get(groupId) ?? new Set<string>();
			folders.add(folder);
			foldersByGroup.set(groupId, folders);
			groupId = groupById.get(groupId)?.parentId ?? null;
		}
	}

	// Match newly discovered show and season groups to one unclaimed existing owner.
	const replacementIds = new Map<string, string>();
	const claimed = new Set<string>();
	for (const group of [...groups].sort((left, right) =>
		(left.sourceKey ?? left.stableKey).localeCompare(right.sourceKey ?? right.stableKey))) {
		const sourceKey = group.sourceKey ?? group.stableKey;
		const showMatch = sourceKey.match(/^show:([^:]+)$/);
		const seasonMatch = sourceKey.match(/^show:([^:]+):season:(\d+)$/);
		const folder = showMatch?.[1] ?? seasonMatch?.[1];
		if (!folder) {
			continue;
		}

		const candidate = existingGroups.find((existing) => {
			if (claimed.has(existing.id) || existing.kind !== group.kind) {
				return false;
			}

			const folders = [...(foldersByGroup.get(existing.id) ?? [])].sort((left, right) =>
				left.localeCompare(right));
			if (folders[0] !== folder) {
				return false;
			}

			if (group.kind === 'season') {
				return existing.metadata.seasonNumber === group.metadata.seasonNumber;
			}

			return true;
		});
		if (candidate) {
			replacementIds.set(group.id, candidate.id);
			group.id = candidate.id;
			group.stableKey = candidate.stableKey;
			claimed.add(candidate.id);
		}
	}

	// Rewrite parent and item references after every replacement ID is known.
	for (const group of groups) {
		if (group.parentId) {
			group.parentId = replacementIds.get(group.parentId) ?? group.parentId;
		}
	}

	for (const item of items) {
		if (item.groupId) {
			item.groupId = replacementIds.get(item.groupId) ?? item.groupId;
		}
	}
}
