import { semanticAnchors } from './source.js';
import { passesSemanticExclusions, preferenceIssue, semanticExclusionScore, exclusionThreshold } from './refinement.js';
import { PROGRAM_PREVIEW_ITEM_LIMIT, type ProgramConfig, type SchedulableMedia, type SchedulingCatalog, type SchedulingProgramPreviewItem } from '@moirai/shared';
import { rankSemanticSelection } from './ranking.js';

/** Read-only preview with the number of eligible related items, independent of carousel limits. */
interface SemanticSample {
	items: SchedulingProgramPreviewItem[];
	matchingCount: number;
}

/** Cache samples against immutable corpus snapshots; retain at most 32 configurations per corpus. */
const samples = new WeakMap<object, Map<string, SemanticSample>>();

/** Rank a read-only sample without creating seeds or advancing scheduling cursors. */
export function semanticSample(
	config: Extract<ProgramConfig, { type: 'similarity' | 'theme' }>,
	sourceIds: string[],
	eligible: SchedulableMedia[],
	catalog: SchedulingCatalog,
): SemanticSample {
	const corpus = catalog.semantic;
	if (!corpus || preferenceIssue(config, catalog)) {
		return { items: [], matchingCount: 0 };
	}
	eligible = eligible.filter((item) => passesSemanticExclusions(item, config, catalog));
	const preference = corpus.preferences?.[config.softPreferences?.trim() ?? '']?.vector;
	const key = JSON.stringify([catalog.cacheKey, config, preference, sourceIds, eligible.map((item) => item.id)]);
	const cache = samples.get(corpus.vectors) ?? new Map<string, SemanticSample>();
	samples.set(corpus.vectors, cache);
	const cached = cache.get(key);
	if (cached) {
		return cached;
	}
	const anchors = semanticAnchors(config, sourceIds, catalog);
	const selection = rankSemanticSelection(anchors, eligible.flatMap((item) => corpus.vectors[item.id]
		? [{ id: item.id, vector: corpus.vectors[item.id]! }] : []), Math.min(config.quantity, PROGRAM_PREVIEW_ITEM_LIMIT), config.variety, [], preference);
	const byId = new Map(eligible.map((item) => [item.id, item]));
	const items = selection.itemIds.map((id) => {
		const media = byId.get(id)!;
		return { id, libraryId: media.libraryId, title: media.title, year: media.year,
			artworkUrl: media.artworkUrl, availability: media.availability };
	});
	const result = { items, matchingCount: selection.matchingCount };
	cache.set(key, result);
	if (cache.size > 32) {
		cache.delete(cache.keys().next().value!);
	}
	return result;
}

/** Show strongest excluded candidates in stable order without creating or consuming seed entries. */
export function semanticExcludedPreview(
	config: Extract<ProgramConfig, { type: 'similarity' | 'theme' }>,
	eligible: SchedulableMedia[],
	catalog: SchedulingCatalog,
): SchedulingProgramPreviewItem[] {
	if (preferenceIssue(config, catalog)) {
		return [];
	}
	return eligible.map((media) => ({ media, score: semanticExclusionScore(media, config, catalog) }))
		.filter(({ score }) => score >= exclusionThreshold(config))
		.sort((left, right) => right.score - left.score || (left.media.id < right.media.id ? -1 : left.media.id > right.media.id ? 1 : 0))
		.slice(0, PROGRAM_PREVIEW_ITEM_LIMIT).map(({ media }) => ({ id: media.id, libraryId: media.libraryId,
			title: media.title, year: media.year, artworkUrl: media.artworkUrl, availability: media.availability }));
}

/** Preserve the item-only preview interface for callers that do not need a pool count. */
export function semanticPreview(
	config: Extract<ProgramConfig, { type: 'similarity' | 'theme' }>, 
	sourceIds: string[],
	eligible: SchedulableMedia[], 
	catalog: SchedulingCatalog,
): SchedulingProgramPreviewItem[] {
	return semanticSample(config, sourceIds, eligible, catalog).items;
}
