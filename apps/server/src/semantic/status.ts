import { semanticSource } from './source.js';
import { passesSemanticExclusions, preferenceIssue, refinementTexts } from './refinement.js';
import type { SchedulingCatalog, SchedulingProgram, SchedulingProgramStatus } from '@moirai/shared';
import { semanticMediaEligible } from './selection.js';
import { semanticSample, semanticExcludedPreview } from './preview.js';

/** Describe source preparation and sample related candidates without changing persistent seeds. */
export function similarityProgramStatus(program: SchedulingProgram, programs: SchedulingProgram[], catalog: SchedulingCatalog): SchedulingProgramStatus {
	if (program.config.type !== 'similarity' && program.config.type !== 'theme') {
		throw new Error('Similarity status requires a Similar Items Program');
	}
	const config = program.config;
	const refinementIssue = preferenceIssue(config, catalog);
	const source = semanticSource(config, programs, catalog);
	const { sourceIds, items } = source;
	const available = items.filter((item) => catalog.semantic?.vectors[item.id] && semanticMediaEligible(item, catalog));
	const ready = available.filter((item) => passesSemanticExclusions(item, config, catalog));
	const relevantIds = new Set([...sourceIds, ...items.map((item) => item.id)]);
	const pending = catalog.semantic?.pendingItemIds.filter((id) => relevantIds.has(id)) ?? [];
	const failed = catalog.semantic?.failedItemIds.filter((id) => relevantIds.has(id)) ?? [];
	const hasAnchors = source.anchors.length > 0;
	const unresolvedRefinement = refinementTexts(config).find((text) => {
		const entry = catalog.semantic?.preferences?.[text];
		return entry?.status !== 'ready' || !entry.vector;
	});
	const refinement = unresolvedRefinement ? catalog.semantic?.preferences?.[unresolvedRefinement] : undefined;
	const sample = semanticSample(program.config, [...sourceIds], ready, catalog);
	return {
		previewPending: Boolean(source.valid && !catalog.semantic?.preparationError && (refinementIssue
			? (!refinement || refinement.status === 'pending') && !refinement?.error : pending.length)),
		programId: program.id, health: !source.valid ? 'missing' : pending.length || failed.length || refinementIssue ? 'degraded' : !hasAnchors ? 'unavailable' : sample.matchingCount ? 'ready' : 'empty',
		currentSets: catalog.semantic?.currentSets?.filter((set) => set.programId === program.id) ?? [],
		sourceLabel: !source.valid ? source.missing : refinementIssue ?? (pending.length
			? catalog.semantic?.preparationError ?? `Preparing matches: ${ready.length} items ready, ${pending.length} pending`
			: !hasAnchors ? 'Source items are not ready for matching.'
				: failed.length ? `Preparation failed for ${failed.length} items; ${ready.length} items ready`
					: sample.matchingCount ? source.label : ready.length ? 'No related playable items match these settings.' : available.length ? 'Semantic exclusions removed all ready candidates. Reduce strictness or edit the concepts.' : 'No other playable items are ready for matching.'),
		indexedItemCount: items.length, availableItemCount: ready.length,
		...(!refinementIssue ? { excludedPreviewItems: semanticExcludedPreview(config, available, catalog) } : {}),
		previewItems: sample.items,
		matchingItemCount: sample.matchingCount, requestedItemCount: config.quantity,
		failedEmbeddingCount: failed.length + refinementTexts(config).filter((text) => catalog.semantic?.preferences?.[text]?.status === 'failed').length,
	};
}
