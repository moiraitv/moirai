import { similarityProgramStatus } from '../semantic/status.js';
import {
	PROGRAM_PREVIEW_ITEM_LIMIT,
	type ProgramConfig,
	type SchedulingCatalog,
	type SchedulingProgram,
	type SchedulingProgramHealth,
	type SchedulingProgramStatus,
} from '@moirai/shared';
import { orderedLibraryQueryMatches } from './content-query.js';
import { indexedContentMatches, orderContentMatches, withoutContentExclusions } from './content-source.js';

/** Return the user-facing label for content. */
function contentLabel(
	config: Extract<ProgramConfig, { type: 'content' }>,
	catalog: SchedulingCatalog,
	firstIndexedTitle: string | undefined,
): string {
	const source = config.source;
	if (source.type === 'item') {
		return firstIndexedTitle ?? 'Missing item';
	}

	if (source.type === 'group') {
		return catalog.groupTitles[source.groupId] ?? 'Missing group';
	}

	if (source.type === 'collection' || source.type === 'ai') {
		const library = catalog.libraryNames[source.libraryId] ?? 'missing library';
		const prefix = source.type === 'ai' ? 'AI selection' : 'selected';
		return `${source.itemIds.length} ${prefix} from ${library}`;
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
	const indexed = indexedContentMatches(source, catalog);
	let missing = false;
	if (source.type === 'item') {
		missing = indexed.length === 0;
	}
	else if (source.type === 'group') {
		missing = !(source.groupId in catalog.groupParents);
	}
	else {
		missing = !(source.libraryId in catalog.libraryAvailability);
	}
	const sourceMatches = withoutContentExclusions(indexed, source, catalog);
	const matches = source.type === 'library-query' ? orderedLibraryQueryMatches(sourceMatches, source) : orderContentMatches(sourceMatches, source, catalog);
	const missingCollectionMembers
		= source.type === 'collection' || source.type === 'ai' ? source.itemIds.length - indexed.length : 0;
	const missingGroupMembers
		= source.type === 'group-collection'
			? source.groupIds.filter((groupId) => !(groupId in catalog.groupParents)).length
			: 0;
	if ((source.type === 'collection' || source.type === 'ai') && source.itemIds.length > 0 && indexed.length === 0) {
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
		sourceLabel: contentLabel(program.config, catalog, indexed[0]?.title),
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

/** Sample distinct media across source previews without simulating sequence playback. */
function sequencePreview(children: SchedulingProgramStatus[]): SchedulingProgramStatus['previewItems'] {
	const items: SchedulingProgramStatus['previewItems'] = [];
	const seen = new Set<string>();
	for (let index = 0; index < PROGRAM_PREVIEW_ITEM_LIMIT; index += 1) {
		for (const child of children) {
			const item = child.previewItems[index];
			if (item && !seen.has(item.id)) {
				seen.add(item.id);
				items.push(item);
				if (items.length === PROGRAM_PREVIEW_ITEM_LIMIT) {
					return items;
				}
			}
		}
	}
	return items;
}

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
			previewItems: sequencePreview(children),
		};
		resolved.set(program.id, status);
		return status;
	};
	return programs.map((program) => resolve(program, new Set()));
}
