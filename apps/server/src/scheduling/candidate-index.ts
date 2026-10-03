import type { SchedulableMedia } from '@moirai/shared';
import type { SelectionContext } from './selection.js';

/** Immutable pool lookups and canonical queue identities owned by one generation. */
export interface CandidateIndex {
	byId: ReadonlyMap<string, SchedulableMedia>;
	canonicalIds: WeakMap<string[], string[]>;
}

/** Reuse membership lookups without caching clock-dependent fit or collision decisions. */
export function candidateIndex(candidates: SchedulableMedia[], context: SelectionContext): CandidateIndex {
	const indexes = context.candidateIndexes ??= new WeakMap();
	let index = indexes.get(candidates);
	if (!index) {
		index = { byId: new Map(candidates.map(media => [media.id, media])), canonicalIds: new WeakMap() };
		indexes.set(candidates, index);
	}
	return index;
}
