import { dot } from '../semantic/ranking.js';
import { AI_EPISODE_LIMIT, AI_MOVIE_LIMIT, type AiCatalogItem, type AiDiscovery } from './content-selection.js';

/** Rank fusion avoids treating embedding scores as a semantic truth threshold. */
const RANK_FUSION_OFFSET = 60;
/** Reserve exploration for poorly described items outside the ranked shortlist. */
const EXPLORATION_FRACTION = 0.1;

/** Normalize authored titles and keywords for deterministic comparison. */
function key(value: string): string {
	return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

/** Resolve research identities against the entire library; ambiguous works remain unselected. */
export function discoveredItems(catalog: AiCatalogItem[], discovery: AiDiscovery): AiCatalogItem[] {
	const ids = new Set<string>();
	for (const candidate of discovery.candidates) {
		const matches = catalog.filter(item => {
			if (key(item.title) !== key(candidate.title) || (candidate.year !== null && item.year !== candidate.year)) {
				return false;
			}
			if (item.kind === 'episode') {
				return Boolean(candidate.series && candidate.season !== null && candidate.season !== undefined
					&& candidate.episode !== null && candidate.episode !== undefined
					&& key(item.series ?? '') === key(candidate.series) && item.season === candidate.season
					&& item.episode === candidate.episode && (candidate.seriesYear == null || item.seriesYear === candidate.seriesYear));
			}
			return !candidate.series;
		});
		if (matches.length === 1) {
			ids.add(matches[0]!.id);
		}
	}
	return catalog.filter(item => ids.has(item.id));
}

/** Fuse positive lexical and semantic ranks, preserving discoveries and a broad exploration tail. */
export function shortlistCandidates(
	catalog: AiCatalogItem[], 
	discovery: AiDiscovery,
	vectors: Record<string, number[]> = {}, 
	queries: number[][] = [],
): AiCatalogItem[] {
	const limit = catalog.some(item => item.kind === 'episode') ? AI_EPISODE_LIMIT : AI_MOVIE_LIMIT;
	const ordered = [...catalog].sort((a, b) => a.id.localeCompare(b.id));
	const scores = new Map(ordered.map(item => [item.id, 0]));
	for (const concept of discovery.concepts) {
		const terms = key(concept).match(/[\p{L}\p{N}]+/gu) ?? [];
		const ranked = ordered.map(item => {
			const text = key([item.title, item.series ?? '', ...item.genres, ...(item.keywords ?? []), item.plot ?? ''].join(' '));
			return { item, score: terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0) };
		}).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
		ranked.forEach((row, rank) => scores.set(row.item.id, scores.get(row.item.id)! + 1 / (RANK_FUSION_OFFSET + rank + 1)));
	}
	for (const query of queries) {
		const ranked = ordered.filter(item => vectors[item.id]?.length === query.length)
			.map(item => ({ item, score: dot(vectors[item.id]!, query) }))
			.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
		ranked.forEach((row, rank) => scores.set(row.item.id, scores.get(row.item.id)! + 1 / (RANK_FUSION_OFFSET + rank + 1)));
	}

	const discovered = discoveredItems(ordered, discovery);
	const discoveredIds = new Set(discovered.map(item => item.id));
	const remaining = ordered.filter(item => !discoveredIds.has(item.id))
		.sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || a.id.localeCompare(b.id));
	const capacity = Math.max(0, limit - discovered.length);
	const explorationCount = Math.min(Math.ceil(capacity * EXPLORATION_FRACTION), remaining.length);
	const ranked = remaining.slice(0, Math.max(0, capacity - explorationCount));
	const tail = remaining.slice(ranked.length).sort((a, b) => a.id.localeCompare(b.id));
	const count = Math.min(explorationCount, tail.length);
	const exploration = Array.from({ length: count }, (_, index) => tail[Math.floor((index + 0.5) * tail.length / count)]!);
	// Put discoveries and exploration ahead of the ranked tail so byte limits preserve both sources.
	return [...discovered, ...exploration, ...ranked];
}
