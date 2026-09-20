import { DEFAULT_SEMANTIC_EXCLUSION_STRICTNESS, type ProgramConfig, type SchedulableMedia, type SchedulingCatalog } from '@moirai/shared';
import { dot } from './ranking.js';

/** Settings consumed by semantic preferences and exclusions. */
type SimilarityConfig = Extract<ProgramConfig, { type: 'similarity' | 'theme' }>;

/** Collect positive preference text and exclusion concepts for the shared local inference cache. */
export function refinementTexts(config: SimilarityConfig): string[] {
	return [...new Set([config.type === 'theme' ? config.theme : '', config.softPreferences ?? '', ...(config.hardExclusions ?? [])].map((text) => text.trim()).filter(Boolean))];
}

/** Higher strictness lowers the cosine cutoff, excluding a broader neighborhood of each concept. */
export function exclusionThreshold(config: SimilarityConfig): number {
	return 0.8 - (config.exclusionStrictness ?? DEFAULT_SEMANTIC_EXCLUSION_STRICTNESS) * 0.003;
}

/** Score against any exclusion concept; missing media vectors remain pending, never random matches. */
export function semanticExclusionScore(media: SchedulableMedia, config: SimilarityConfig, catalog: SchedulingCatalog): number {
	const vector = catalog.semantic?.vectors[media.id];
	if (!vector) {
		return -1;
	}
	return Math.max(-1, ...(config.hardExclusions ?? []).map((text) => {
		const concept = catalog.semantic?.preferences?.[text.trim()];
		return concept?.status === 'ready' && concept.vector ? dot(vector, concept.vector) : -1;
	}));
}

/** Remove semantic matches before ranking; seed consumption intentionally does not rerun this filter. */
export function passesSemanticExclusions(media: SchedulableMedia, config: SimilarityConfig, catalog: SchedulingCatalog): boolean {
	return semanticExclusionScore(media, config, catalog) < exclusionThreshold(config);
}

/** Wait for all requested concepts instead of silently scheduling without an exclusion. */
export function preferenceIssue(config: SimilarityConfig, catalog: SchedulingCatalog): string | null {
	for (const text of refinementTexts(config)) {
		const preference = catalog.semantic?.preferences?.[text];
		if (preference?.status === 'ready' && preference.vector) {
			continue;
		}
		const label = (config.hardExclusions ?? []).includes(text) ? 'exclusion' : config.type === 'theme' && config.theme === text ? 'theme' : 'soft preference';
		return preference?.status === 'failed' ? `Could not prepare the ${label}. Choose Retry preparation to try again.`
			: preference?.error ?? catalog.semantic?.preparationError ?? `Preparing the ${label} for matching.`;
	}
	return null;
}
