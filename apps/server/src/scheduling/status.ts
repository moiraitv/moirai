import { similarityProgramStatus } from '../semantic/status.js';
import {
	orderSelectedMedia,
	PROGRAM_PREVIEW_ITEM_LIMIT,
	type ProgramConfig,
	type SchedulableMedia,
	type SchedulingCatalog,
	type SchedulingProgram,
	type SchedulingProgramHealth,
	type SchedulingProgramStatus,
} from '@moirai/shared';
import {
	compareLibraryQueryMedia,
	compareSchedulingMedia,
	mediaMatchesLibraryQuery,
} from './content-query.js';

/** Check whether one indexed group descends from another. */
function descendantOf(
	groupId: string | null,
	ancestorId: string,
	parents: Record<string, string | null>,
): boolean {
	const visited = new Set<string>();
	let current = groupId;
	while (current) {
		if (current === ancestorId) {
			return true;
		}

		if (visited.has(current)) {
			return false;
		}

		visited.add(current);
		current = parents[current] ?? null;
	}
	return false;
}

/** Return catalog media eligible for one content source. */
export function schedulingContentMatches(
	config: Extract<ProgramConfig, { type: 'content' }>,
	catalog: SchedulingCatalog,
): SchedulableMedia[] {
	const byId = catalog.mediaById ?? new Map(catalog.media.map((media) => [media.id, media]));
	const byLibrary = catalog.mediaByLibrary;
	const source = config.source;
	const collectionItemIds = source.type === 'collection' && source.sort.type === 'manual'
		? source.sort.itemIds
		: source.type === 'collection'
			? source.itemIds
			: [];
	const pool
		= source.type === 'item'
			? [byId.get(source.itemId)].filter((media): media is SchedulableMedia => Boolean(media))
			: source.type === 'collection'
				? collectionItemIds.flatMap((itemId) => {
					const media = byId.get(itemId);
					return media ? [media] : [];
				})
				: 'libraryId' in source && byLibrary
					? (byLibrary.get(source.libraryId) ?? [])
					: catalog.media;
	return pool.filter((media) => {
		if (config.source.type === 'item') {
			return media.id === config.source.itemId;
		}

		if (config.source.type === 'group') {
			return config.source.includeDescendants
				? descendantOf(media.groupId, config.source.groupId, catalog.groupParents)
				: media.groupId === config.source.groupId;
		}

		if (config.source.type === 'group-collection') {
			return (
				media.libraryId === config.source.libraryId
				&& config.source.groupIds.some((groupId) =>
					descendantOf(media.groupId, groupId, catalog.groupParents))
			);
		}

		if (config.source.type === 'collection') {
			return (
				media.libraryId === config.source.libraryId && config.source.itemIds.includes(media.id)
			);
		}

		return mediaMatchesLibraryQuery(media, config.source);
	});
}

/** Return the user-facing label for content. */
function contentLabel(
	config: Extract<ProgramConfig, { type: 'content' }>,
	catalog: SchedulingCatalog,
): string {
	const source = config.source;
	if (source.type === 'item') {
		return (
			(
				catalog.mediaById?.get(source.itemId)
				?? catalog.media.find((media) => media.id === source.itemId)
			)?.title ?? 'Missing item'
		);
	}

	if (source.type === 'group') {
		return catalog.groupTitles[source.groupId] ?? 'Missing group';
	}

	if (source.type === 'collection') {
		const library = catalog.libraryNames[source.libraryId] ?? 'missing library';
		return `${source.itemIds.length} selected from ${library}`;
	}

	if (source.type === 'group-collection') {
		const library = catalog.libraryNames[source.libraryId] ?? 'missing library';
		return `${source.groupIds.length} selected media groups from ${library}`;
	}

	return catalog.libraryNames[source.libraryId] ?? 'Missing library';
}

/** Summarize whether a content source is playable, degraded, or empty. */
function contentStatus(
	program: SchedulingProgram,
	catalog: SchedulingCatalog,
): SchedulingProgramStatus {
	if (program.config.type !== 'content') {
		throw new Error('Content status requires a content program');
	}

	const source = program.config.source;
	let missing = false;
	if (source.type === 'item') {
		missing = !(
			catalog.mediaById?.has(source.itemId)
			?? catalog.media.some((media) => media.id === source.itemId)
		);
	}
	else if (source.type === 'group') {
		missing = !(source.groupId in catalog.groupParents);
	}
	else {
		missing = !(source.libraryId in catalog.libraryAvailability);
	}
	const sourceMatches = schedulingContentMatches(program.config, catalog);
	const orderedMatches = source.type === 'collection'
		? orderSelectedMedia(sourceMatches, source.sort, source.additionBatches)
		: source.type === 'library-query'
			? sourceMatches.sort((left, right) => compareLibraryQueryMedia(left, right, source.sort))
			: sourceMatches.sort(compareSchedulingMedia);
	const matches = source.type === 'library-query' && source.itemLimit != null
		? orderedMatches.slice(0, source.itemLimit)
		: orderedMatches;
	const missingCollectionMembers
		= source.type === 'collection' ? source.itemIds.length - matches.length : 0;
	const missingGroupMembers
		= source.type === 'group-collection'
			? source.groupIds.filter((groupId) => !(groupId in catalog.groupParents)).length
			: 0;
	if (source.type === 'collection' && matches.length === 0) {
		missing = true;
	}
	if (source.type === 'group-collection' && missingGroupMembers === source.groupIds.length) {
		missing = true;
	}
	const available = matches.filter((media) => {
		const library = catalog.libraryAvailability[media.libraryId] ?? 'unknown';
		return (
			media.availability === 'available'
			&& media.durationSeconds !== null
			&& media.durationSeconds > 0
			&& (library === 'available' || library === 'degraded')
		);
	});
	const health: SchedulingProgramHealth = missing
		? 'missing'
		: matches.length === 0
			? 'empty'
			: available.length === 0
				? 'unavailable'
				: available.length < matches.length
					|| missingCollectionMembers > 0
					|| missingGroupMembers > 0
					? 'degraded'
					: 'ready';
	return {
		programId: program.id,
		health,
		sourceLabel: contentLabel(program.config, catalog),
		indexedItemCount: matches.length,
		availableItemCount: available.length,
		previewItems: matches.slice(0, PROGRAM_PREVIEW_ITEM_LIMIT).map((media) => ({
			id: media.id,
			libraryId: media.libraryId,
			title: media.title,
			year: media.year,
			artworkUrl: media.artworkUrl,
			availability: media.availability,
		})),
	};
}

/** Severity ordering used when a composite program inherits child health. */
const healthRank: Record<SchedulingProgramHealth, number> = {
	ready: 0,
	degraded: 1,
	empty: 2,
	unavailable: 3,
	missing: 4,
};

/** Summarize source eligibility for the scheduling UI without exposing the full catalog. */
export function schedulingProgramStatuses(
	programs: SchedulingProgram[],
	catalog: SchedulingCatalog,
): SchedulingProgramStatus[] {
	const byId = new Map(programs.map((program) => [program.id, program]));
	const resolved = new Map<string, SchedulingProgramStatus>();
	const resolve = (program: SchedulingProgram, ancestry: Set<string>): SchedulingProgramStatus => {
		const cached = resolved.get(program.id);
		if (cached) {
			return cached;
		}

		if (program.config.type === 'content') {
			const status = contentStatus(program, catalog);
			resolved.set(program.id, status);
			return status;
		}

		if (program.config.type === 'similarity' || program.config.type === 'theme') {
			const status = similarityProgramStatus(program, programs, catalog);
			resolved.set(program.id, status);
			return status;
		}

		const nextAncestry = new Set(ancestry).add(program.id);
		const children = program.config.entries.map((entry) => {
			const child = byId.get(entry.programId);
			if (!child || nextAncestry.has(entry.programId)) {
				return {
					programId: entry.programId,
					health: 'missing' as const,
					sourceLabel: 'Missing program',
					indexedItemCount: 0,
					availableItemCount: 0,
					previewItems: [],
				};
			}

			return resolve(child, nextAncestry);
		});
		const health = children.reduce<SchedulingProgramHealth>(
			(worst, child) => (healthRank[child.health] > healthRank[worst] ? child.health : worst),
			'ready',
		);
		const status: SchedulingProgramStatus = {
			programId: program.id,
			health: children.length === 0 ? 'empty' : health,
			sourceLabel: `${program.config.entries.length} step sequence`,
			indexedItemCount: children.reduce((sum, child) => sum + child.indexedItemCount, 0),
			availableItemCount: children.reduce((sum, child) => sum + child.availableItemCount, 0),
			previewItems: [],
		};
		resolved.set(program.id, status);
		return status;
	};
	return programs.map((program) => resolve(program, new Set()));
}
