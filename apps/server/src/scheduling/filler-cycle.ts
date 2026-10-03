import type { FillerCycle, SchedulableMedia, SelectionStateRecord } from '@moirai/shared';
import { candidateIndex } from './candidate-index.js';
import { selectOrderedCandidate } from './candidate-selection.js';
import type { SelectionContext } from './selection.js';

/** Determine whole-stage eligibility independently of its smaller remaining gap. */
export function eligibleFiller(media: SchedulableMedia, context: SelectionContext): boolean {
	return Boolean(context.fillerSelection?.allowTruncation)
		|| media.durationSeconds! <= context.fillerSelection!.fullBudgetSeconds;
}

/** Preserve deferred positions while appending new eligible cycles without duplicate identities. */
export function selectFillerCandidate(
	candidates: SchedulableMedia[],
	record: SelectionStateRecord,
	context: SelectionContext,
	fitSeconds: number | null,
	order: (cycle: number) => SchedulableMedia[],
): SchedulableMedia | null {
	const { byId, canonicalIds } = candidateIndex(candidates, context);
	const canonical = (ids: string[]): string[] => {
		let result = canonicalIds.get(ids);
		if (!result) {
			result = [...new Set(ids.map(id => context.catalog.mediaAliases?.[id] ?? id))].filter(id => byId.has(id));
			canonicalIds.set(ids, result);
			canonicalIds.set(result, result);
		}
		return result;
	};
	const prior = record.value.fillerCycle;
	let cycle: FillerCycle;
	if (prior) {
		cycle = { ...prior, itemIds: canonical(prior.itemIds), remainingItemIds: canonical(prior.remainingItemIds) };
	}
	else {
		const value = record.value;
		const initialCycle = value.type === 'shuffle' ? value.cycle : 'counter' in value ? value.counter : 0;
		const initial = canonical(order(initialCycle).map(media => media.id));
		const afterLast = value.type === 'sequential' && value.lastItemId ? candidates.findIndex(media => media.id === value.lastItemId) + 1 : 0;
		const sequentialPosition = value.type === 'sequential' ? afterLast > 0 ? afterLast : value.nextIndex % candidates.length : 0;
		const consumed = value.type === 'similarity' ? new Set(canonical(value.consumedItemIds)) : new Set<string>();
		const remaining = value.type === 'shuffle' && value.cycleItemIds.length ? canonical(value.remainingItemIds)
			: value.type === 'similarity' ? initial.filter(id => !consumed.has(id))
				: value.type === 'sequential' ? candidates.slice(sequentialPosition).map(media => media.id) : initial;
		cycle = { version: 1, cycle: initialCycle, itemIds: value.type === 'shuffle' && value.cycleItemIds.length ? canonical(value.cycleItemIds) : initial, remainingItemIds: remaining };
	}

	// Reconcile new members once; removals do not reset already consumed membership.
	const known = new Set(cycle.itemIds);
	const added = candidates.filter(media => !known.has(media.id));
	if (added.length) {
		const addedIds = new Set(added.map(media => media.id));
		cycle.remainingItemIds = [...cycle.remainingItemIds, ...canonical(order(cycle.cycle).filter(media => addedIds.has(media.id)).map(media => media.id))];
		cycle.itemIds = [...cycle.itemIds, ...canonical(added.map(media => media.id))];
	}
	if (!cycle.remainingItemIds.some(id => eligibleFiller(byId.get(id)!, context))) {
		const queued = new Set(cycle.remainingItemIds);
		cycle.cycle += 1;
		const next = canonical(order(cycle.cycle).filter(media => !queued.has(media.id) && eligibleFiller(media, context)).map(media => media.id));
		if ((record.value.type === 'shuffle' || record.value.type === 'weighted-random') && next.length > 1 && next[0] === record.value.lastItemId) {
			next.push(next.shift()!);
		}
		cycle.remainingItemIds = [...cycle.remainingItemIds, ...next];
	}

	// Collision preference affects this pick, never cycle exhaustion or membership.
	const remaining = cycle.remainingItemIds.map(id => byId.get(id)!);
	const selected = selectOrderedCandidate(remaining, context, fitSeconds, 'first-fit-arbitrary');
	if (!selected) {
		return null;
	}
	cycle.remainingItemIds = cycle.remainingItemIds.filter(id => id !== selected.id);
	record.value.fillerCycle = cycle;
	record.updatedAt = context.now;
	return selected;
}
