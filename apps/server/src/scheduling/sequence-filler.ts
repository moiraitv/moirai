import type { SelectionStateRecord } from '@moirai/shared';
import { nextRotation, rotationEntry, type SequenceConfig, type SequenceRotation, type SequenceState } from './sequence-rotation.js';
import type { FillerFit, SelectionContext, SelectionResult, selectProgram } from './selection.js';

/** Cap the search across nested entry paths for one proposed filler clip. */
export const SEQUENCE_FILLER_PROBE_LIMIT = 512;

/** Restore ordered tail cursors saved before filler used rotation state for every Sequence. */
function restoreRotation(config: SequenceConfig, consumerKey: string, value: SequenceState): SequenceRotation {
	if (value.rotation) {
		return value.rotation;
	}

	const rotation = nextRotation(config, consumerKey);
	if (!config.ordering || config.ordering.type === 'ordered') {
		rotation.remaining = rotation.remaining.map((count, index) => index < value.entryIndex ? 0
			: index === value.entryIndex ? Math.max(0, count - value.selectedInEntry) : count);
	}
	return rotation;
}

/** Select a leaf across Sequence turns while carrying oversized allocations forward without duplication. */
export function selectFillerSequence(
	config: SequenceConfig,
	consumerKey: string,
	state: Map<string, SelectionStateRecord>,
	record: SelectionStateRecord,
	context: SelectionContext,
	fitSeconds: number | null,
	ancestry: string[],
	selectChild: typeof selectProgram,
): SelectionResult | null {
	const value = record.value as SequenceState;
	const filler = context.fillerSelection!;
	const probes = filler.probes ?? { remaining: SEQUENCE_FILLER_PROBE_LIMIT };
	const chance = config.ordering?.type === 'chance';
	const unavailable = new Set<number>();
	let rotation = restoreRotation(config, consumerKey, value);
	const deferred = rotation.deferred ?? config.entries.map(() => 0);
	let wholeStage = false;
	let playable = false;

	/** Probe a child using its own leaf queues and carry fit information back to this parent. */
	function tryTurn(index: number, turns: number[]): SelectionResult | null {
		const entry = config.entries[index]!;
		const fit: FillerFit = { playable: false, wholeStage: false };
		probes.remaining -= 1;
		const childContext = { ...context, fillerSelection: { ...filler, fit, probes } };
		const selected = selectChild(entry.programId, `${consumerKey}:entry:${entry.id}`, state, childContext, fitSeconds, 'first-fit-arbitrary', ancestry);
		if (!selected) {
			playable ||= fit.playable;
			wholeStage ||= fit.wholeStage;
			if (turns !== deferred) {
				if (!fit.playable) {
					unavailable.add(index);
					turns[index] = 0;
				}
				else if (!rotation.waiting?.includes(index)) {
					(rotation.waiting ??= []).push(index);
				}
			}
			return null;
		}

		turns[index]! -= 1;
		if (rotation.waiting) {
			rotation.waiting = rotation.waiting.filter(entry => entry !== index && rotation.remaining[entry]! > 0);
		}
		rotation.lastEntry = index;
		rotation.deferred = deferred;
		value.rotation = rotation;
		value.completed = !config.repeat && rotation.remaining.every(count => count === 0) && deferred.every(count => count === 0);
		record.updatedAt = context.now;
		selected.sequenceEntryPath = [entry.id, ...(selected.sequenceEntryPath ?? [])];
		selected.state.set(consumerKey, record);
		return selected;
	}

	// Outstanding allocations from earlier cycles have first claim on a newly fitting gap.
	for (const [index, count] of deferred.entries()) {
		if (probes.remaining > 0 && count > 0) {
			const selected = tryTurn(index, deferred);
			if (selected) {
				return selected;
			}
		}
	}

	// Test the active cycle in order, then refill only if none of its turns could use a full break.
	// Chance can need another pass if a newly rolled child is unavailable. Each such pass rules out
	// at least one step, and counted cycles need at most one refill.
	for (let refill = 0; probes.remaining > 0 && refill <= (chance ? config.entries.length : 1); refill += 1) {
		const tried = new Set<number>();
		for (const index of rotation.waiting ?? []) {
			if (probes.remaining > 0 && rotation.remaining[index]! > 0) {
				tried.add(index);
				const selected = tryTurn(index, rotation.remaining);
				if (selected) {
					return selected;
				}
			}
		}
		for (let index = rotationEntry(config, rotation, consumerKey, tried); probes.remaining > 0 && index !== undefined;
			index = rotationEntry(config, rotation, consumerKey, tried)) {
			tried.add(index);
			const selected = tryTurn(index, rotation.remaining);
			if (selected) {
				return selected;
			}
		}

		if (probes.remaining === 0 || wholeStage || (playable && filler.allowTruncation) || !config.repeat) {
			break;
		}
		for (const [index, count] of rotation.remaining.entries()) {
			if (count > 0) {
				deferred[index] = count;
			}
		}
		const excluded = new Set(unavailable);
		for (const [index, count] of deferred.entries()) {
			if (count > 0) {
				excluded.add(index);
			}
		}
		if (!config.entries.some((entry, index) => entry.count > 0 && !excluded.has(index))) {
			break;
		}
		rotation = nextRotation(config, consumerKey, rotation, excluded);
	}

	if (filler.fit) {
		filler.fit.playable = playable;
		filler.fit.wholeStage = wholeStage;
	}
	return null;
}
