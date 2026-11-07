import { mergeContentExclusions, orderSelectedMedia, type ContentExclusions, type ContentSource, type SchedulableMedia, type SchedulingCatalog } from '@moirai/shared';
import { compareLibraryQueryMedia, compareSchedulingMedia, mediaMatchesLibraryQuery } from './content-query.js';

/** Match group roots and their descendants, memoizing the result for each visited group. */
function groupMembership(groupIds: Iterable<string>, parents: SchedulingCatalog['groupParents']) {
	const roots = new Set(groupIds);
	const membership = new Map<string, boolean>();
	return (groupId: string | null): boolean => {
		if (!groupId) {
			return false;
		}
		const cached = membership.get(groupId);
		if (cached !== undefined) {
			return cached;
		}

		const visited = new Set<string>();
		let current: string | null = groupId;
		let matched = false;
		while (current && !visited.has(current)) {
			if (roots.has(current)) {
				matched = true;
				break;
			}
			const known = membership.get(current);
			if (known !== undefined) {
				matched = known;
				break;
			}
			visited.add(current);
			current = parents[current] ?? null;
		}
		for (const id of visited) {
			membership.set(id, matched);
		}
		membership.set(groupId, matched);
		return matched;
	};
}

/** Build a predicate over indexed media, following canonical item IDs and current group ancestry. */
export function contentExclusionMatcher(exclusions: ContentExclusions | undefined, catalog: SchedulingCatalog) {
	if (!exclusions || (!exclusions.itemIds.length && !exclusions.groupIds.length)) {
		return undefined;
	}

	const items = new Set(exclusions.itemIds.map(id => catalog.mediaAliases?.[id] ?? id));
	const inExcludedGroup = exclusions.groupIds.length ? groupMembership(exclusions.groupIds, catalog.groupParents) : undefined;
	return (media: Pick<SchedulableMedia, 'id' | 'groupId'>): boolean => items.has(media.id) || Boolean(inExcludedGroup?.(media.groupId));
}

/** Remove excluded media while retaining the source's authored order and reference diagnostics. */
export function withoutContentExclusions(matches: SchedulableMedia[], source: ContentSource, catalog: SchedulingCatalog): SchedulableMedia[] {
	const excluded = contentExclusionMatcher(sourceExclusions(source), catalog);
	return excluded ? matches.filter(media => !excluded(media)) : matches;
}

/** Apply a source's playback order before any query limit or playable subset. */
export function orderContentMatches(matches: SchedulableMedia[], source: ContentSource, catalog: SchedulingCatalog): SchedulableMedia[] {
	if (source.type === 'library-query') {
		return matches.sort((left, right) => compareLibraryQueryMedia(left, right, source.sort));
	}
	if (source.type === 'collection' || source.type === 'ai') {
		const sort = source.sort;
		if (source.type === 'ai' && sort.type === 'date-added') {
			return matches.sort((left, right) => compareLibraryQueryMedia(left, right, sort));
		}
		return orderSelectedMedia(matches, source.sort, source.type === 'collection'
			? source.additionBatches?.map(batch => batch.map(id => catalog.mediaAliases?.[id] ?? id)) : undefined);
	}
	return matches.sort(compareSchedulingMedia);
}

/** Find the next playable offset when the last item was excluded or fell outside a query limit. */
export function omittedContentSuccessor(
	indexed: SchedulableMedia[],
	playable: SchedulableMedia[],
	source: ContentSource,
	catalog: SchedulingCatalog,
	excluded: ReturnType<typeof contentExclusionMatcher>,
	cappedMatches: SchedulableMedia[] | undefined,
): (lastId: string) => number | undefined {
	let ordered: SchedulableMedia[] | undefined;
	let offsets: Map<string, number> | undefined;
	return id => {
		const previous = catalog.mediaById?.get(id) ?? indexed.find(media => media.id === id);
		if (!previous || (!excluded?.(previous) && (!cappedMatches || cappedMatches.some(media => media.id === id)))) {
			return undefined;
		}

		ordered ??= orderContentMatches(indexed, source, catalog);
		const position = ordered.findIndex(media => media.id === id);
		if (position < 0) {
			return undefined;
		}
		offsets ??= new Map(playable.map((media, index) => [media.id, index]));
		for (let index = position + 1; index < ordered.length; index++) {
			const next = offsets.get(ordered[index]!.id);
			if (next !== undefined) {
				return next;
			}
		}
		return playable.length;
	};
}

/** Read effective Content exclusions, including earlier item-only AI removals. */
export function sourceExclusions(source: ContentSource): ContentExclusions | undefined {
	return mergeContentExclusions(
		'exclusions' in source ? source.exclusions : undefined,
		source.type === 'ai' ? source.excludedItemIds : undefined,
	);
}

/** Resolve indexed inclusions before exclusions, availability checks, and query limits. */
export function indexedContentMatches(source: ContentSource, catalog: SchedulingCatalog): SchedulableMedia[] {
	if (source.type === 'item' || source.type === 'collection' || source.type === 'ai') {
		const byId = catalog.mediaById ?? new Map(catalog.media.map(media => [media.id, media]));
		if (source.type === 'item') {
			const media = byId.get(catalog.mediaAliases?.[source.itemId] ?? source.itemId);
			return media ? [media] : [];
		}

		const itemIds = source.sort.type === 'manual' ? source.sort.itemIds : source.itemIds;
		return itemIds.flatMap(id => {
			const media = byId.get(catalog.mediaAliases?.[id] ?? id);
			return media?.libraryId === source.libraryId ? [media] : [];
		});
	}

	if (source.type === 'group') {
		const contains = source.includeDescendants ? groupMembership([source.groupId], catalog.groupParents) : undefined;
		return catalog.media.filter(media => contains ? contains(media.groupId) : media.groupId === source.groupId);
	}

	const pool = catalog.mediaByLibrary ? catalog.mediaByLibrary.get(source.libraryId) ?? [] : catalog.media;
	if (source.type === 'group-collection') {
		const contains = groupMembership(source.groupIds, catalog.groupParents);
		return pool.filter(media => media.libraryId === source.libraryId && contains(media.groupId));
	}
	return pool.filter(media => mediaMatchesLibraryQuery(media, source));
}
