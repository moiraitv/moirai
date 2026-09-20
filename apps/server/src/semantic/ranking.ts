/** Normalized vector associated with a stable playable media identifier. */
export interface SemanticCandidate {
	id: string;
	vector: readonly number[];
}

/** Normalize a finite nonzero embedding, rejecting corrupt or incompatible model output. */
export function normalizeVector(vector: readonly number[]): number[] {
	if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
		throw new Error('Invalid semantic vector');
	}
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	if (norm === 0) {
		throw new Error('Empty semantic vector');
	}
	return vector.map((value) => value / norm);
}

/** Compute cosine similarity for normalized, equally sized vectors. */
export function dot(left: readonly number[], right: readonly number[]): number {
	if (left.length !== right.length) {
		throw new Error('Incompatible semantic dimensions');
	}
	return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}

/** Ranked IDs and the full relevant-pool size before the quantity limit. */
export interface SemanticSelection {
	itemIds: string[];
	matchingCount: number;
}

/** Rank relevant candidates, preferring unseen and then least-recently selected sets. */
export function rankSemanticSelection(
	anchors: readonly number[][],
	candidates: SemanticCandidate[],
	quantity: number,
	variety: number,
	previous: readonly string[] = [],
	preference?: readonly number[],
	history: readonly (readonly string[])[] = [],
): SemanticSelection {
	if (anchors.length === 0 || candidates.length === 0) {
		return { itemIds: [], matchingCount: 0 };
	}
	const mean = anchors[0]!.map((_, index) =>
		anchors.reduce((sum, anchor) => sum + anchor[index]!, 0) / anchors.length);
	const centroid = mean.some((value) => value !== 0) ? normalizeVector(mean) : mean;
	const scored = candidates.map((candidate) => {
		const anchorScore = anchors.reduce((best, anchor) => Math.max(best, dot(anchor, candidate.vector)), -Infinity);
		return { ...candidate, redundancy: 0, anchorScore, relevance: (dot(centroid, candidate.vector) + anchorScore) / 2 };
	});
	const best = scored.reduce((best, candidate) => Math.max(best, candidate.relevance), -Infinity);
	const pool = scored.filter((candidate) => candidate.anchorScore > 0 && candidate.relevance >= best - 0.15);
	// Preferences influence order only inside the source-related pool.
	for (const candidate of pool) {
		if (preference) {
			candidate.relevance = 0.7 * candidate.relevance + 0.3 * dot(preference, candidate.vector);
		}
	}
	const selected: typeof pool = [];
	const used = new Set<string>();
	const recency = new Map<string, number>();
	[previous, ...history].forEach((items, age) => {
		for (const id of items) {
			if (!recency.has(id)) {
				recency.set(id, age);
			}
		}
	});
	const lambda = 1 - Math.max(0, Math.min(100, variety)) * 0.0045;
	while (selected.length < quantity) {
		const remaining = pool.filter((candidate) => !used.has(candidate.id));
		const oldest = remaining.reduce((age, candidate) => Math.max(age, recency.get(candidate.id) ?? Infinity), -Infinity);
		const choices = remaining.filter((candidate) => (recency.get(candidate.id) ?? Infinity) === oldest);
		if (choices.length === 0) {
			break;
		}
		const winner = choices.reduce((best, candidate) => {
			const score = lambda * candidate.relevance - (1 - lambda) * candidate.redundancy;
			const bestScore = lambda * best.relevance - (1 - lambda) * best.redundancy;
			return score > bestScore || (score === bestScore && candidate.id < best.id) ? candidate : best;
		});
		for (const candidate of remaining) {
			const similarity = dot(candidate.vector, winner.vector);
			candidate.redundancy = selected.length ? Math.max(candidate.redundancy, similarity) : similarity;
		}
		used.add(winner.id);
		selected.push(winner);
	}
	return { itemIds: selected.map((candidate) => candidate.id), matchingCount: pool.length };
}

/** Select stable IDs while keeping the full-pool count available to preview callers separately. */
export function rankSemanticCandidates(
	anchors: readonly number[][],
	candidates: SemanticCandidate[],
	quantity: number,
	variety: number,
	previous: readonly string[] = [],
	preference?: readonly number[],
	history: readonly (readonly string[])[] = [],
): string[] {
	return rankSemanticSelection(anchors, candidates, quantity, variety, previous, preference, history).itemIds;
}
