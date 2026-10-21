import type { SchedulingCatalog, SchedulingProgram, SemanticMatchesRequest, SemanticMatchesResponse } from '@moirai/shared';
import { semanticRemovedIds, semanticSource } from './source.js';
import { passesSemanticExclusions, preferenceIssue } from './refinement.js';
import { semanticMediaEligible } from './selection.js';
import { semanticRelevancePool } from './ranking.js';
import { similarityProgramStatus } from './status.js';

/** Review all related ready items with stable paging, without creating or consuming seeds. */
export function semanticMatches(input: SemanticMatchesRequest, draft: SchedulingProgram, programs: SchedulingProgram[], catalog: SchedulingCatalog): SemanticMatchesResponse {
	const config = { ...input.config,
		excludedItemIds: [...new Set([...input.config.excludedItemIds ?? [], ...input.additionalExcludedItemIds ?? []])] };
	const status = similarityProgramStatus(draft, programs, catalog);
	const source = semanticSource(input.config, programs, catalog);
	if (!source.valid) {
		throw Object.assign(new Error(source.missing), { statusCode: 400, expose: true });
	}
	const eligible = source.items.filter((media) => semanticMediaEligible(media, catalog) && passesSemanticExclusions(media, config, catalog));
	const byId = new Map(eligible.map((media) => [media.id, media]));
	const candidates = eligible.flatMap((media) => catalog.semantic?.vectors[media.id]
		? [{ id: media.id, vector: catalog.semantic.vectors[media.id]! }] : []);
	const preference = catalog.semantic?.preferences?.[config.softPreferences?.trim() ?? '']?.vector;
	const pool = preferenceIssue(config, catalog) ? [] : semanticRelevancePool(source.anchors, candidates, preference);
	const query = input.search.toLocaleLowerCase();
	const removed = semanticRemovedIds(config, catalog);
	const matches = pool.filter((entry) => {
		const media = byId.get(entry.id)!;
		return !removed.has(entry.id) && `${media.title} ${media.year ?? ''}`.toLocaleLowerCase().includes(query);
	}).sort((left, right) => right.relevance - left.relevance || left.id.localeCompare(right.id));
	const offset = input.cursor === null ? 0 : Number(input.cursor);
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw Object.assign(new Error('Invalid match cursor'), { statusCode: 400, expose: true });
	}

	const end = Math.min(matches.length, offset + input.limit);
	return {
		items: matches.slice(offset, end).map(({ id }) => {
			const media = byId.get(id)!;
			return { id, libraryId: media.libraryId, title: media.title, year: media.year,
				artworkUrl: media.artworkUrl, availability: media.availability };
		}),
		total: matches.length, nextCursor: end < matches.length ? String(end) : null,
		pending: status.previewPending ?? false,
		preparationFailed: Boolean(status.failedEmbeddingCount || (!status.previewPending && (preferenceIssue(config, catalog) || status.health === 'unavailable'))),
		message: status.sourceLabel,
	};
}
