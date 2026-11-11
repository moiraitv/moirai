import type { SchedulingProgram, SelectionStateRecord } from '@moirai/shared';
import { nextRotation, rotationEntry, type SequenceConfig, type SequenceState } from './sequence-rotation.js';
import { selectFillerSequence } from './sequence-filler.js';
import type { SelectionContext, SelectionFitMode, SelectionResult, selectProgram } from './selection.js';

/** Select one leaf and advance the parent only with a successful result. */
export function selectSequence(
	program: SchedulingProgram,
	consumerKey: string,
	state: Map<string, SelectionStateRecord>,
	record: SelectionStateRecord,
	context: SelectionContext,
	fitSeconds: number | null,
	fitMode: SelectionFitMode,
	ancestry: string[],
	selectChild: typeof selectProgram,
): SelectionResult | null {
	if (program.config.type !== 'sequence') {
		return null;
	}
	const value = record.value as SequenceState;
	if (value.completed) {
		return null;
	}

	if (context.fillerSelection) {
		return selectFillerSequence(program.config, consumerKey, state, record, context, fitSeconds, [...ancestry, program.id], selectChild);
	}
	if (program.config.ordering?.type === 'chance') {
		return selectChance(program.config, consumerKey, state, record, context, fitSeconds, fitMode, [...ancestry, program.id], selectChild);
	}
	if (program.config.ordering && program.config.ordering.type !== 'ordered') {
		return selectRotation(program, consumerKey, state, record, context, fitSeconds, fitMode, ancestry, selectChild);
	}

	// Walk composite entries until one selects media or the sequence becomes blocked.
	for (let attempts = 0; attempts < program.config.entries.length; attempts += 1) {
		const entry = program.config.entries[value.entryIndex];
		if (!entry) {
			return null;
		}

		const selected = selectChild(
			entry.programId,
			`${consumerKey}:entry:${entry.id}`,
			state,
			context,
			fitSeconds,
			fitMode,
			[...ancestry, program.id],
		);
		if (selected) {
			selected.sequenceEntryPath = [entry.id, ...(selected.sequenceEntryPath ?? [])];
			value.selectedInEntry += 1;
			if (value.selectedInEntry >= entry.count) {
				value.selectedInEntry = 0;
				value.entryIndex += 1;
				if (value.entryIndex >= program.config.entries.length) {
					value.entryIndex = 0;
					value.completed = !program.config.repeat;
				}
			}
			record.updatedAt = context.now;
			selected.state.set(consumerKey, record);
			return selected;
		}

		if (fitSeconds !== null && fitMode === 'first-fit-arbitrary') {
			return null;
		}

		if (context.blockedPrograms.has(entry.programId)) {
			context.blockedPrograms.add(program.id);
			return null;
		}

		value.selectedInEntry = 0;
		value.entryIndex += 1;
		if (value.entryIndex >= program.config.entries.length) {
			value.entryIndex = 0;
			if (!program.config.repeat) {
				value.completed = true;
				record.updatedAt = context.now;
				state.set(consumerKey, record);
				return null;
			}
		}
	}
	return null;
}

/** Spend rotation quotas while preserving primary fit rejection and source blocking. */
function selectRotation(
	program: SchedulingProgram,
	consumerKey: string,
	state: Map<string, SelectionStateRecord>,
	record: SelectionStateRecord,
	context: SelectionContext,
	fitSeconds: number | null,
	fitMode: SelectionFitMode,
	ancestry: string[],
	selectChild: typeof selectProgram,
): SelectionResult | null {
	const config = program.config;
	if (config.type !== 'sequence') {
		return null;
	}
	const value = record.value as SequenceState;
	if (!value.rotation || value.rotation.remaining.every((count) => count === 0)) {
		value.rotation = nextRotation(config, consumerKey, value.rotation);
	}

	// Try each eligible child at most once; rejected candidates do not spend quotas.
	let rotation = value.rotation!;
	const excluded = new Set<number>();
	for (let attempts = 0; attempts < config.entries.length; attempts += 1) {
		const index = rotationEntry(config, rotation, consumerKey, excluded);
		if (index === undefined) {
			break;
		}
		const entry = config.entries[index]!;
		const priorFitRejections = context.fitRejectionCount;
		const selected = selectChild(
			entry.programId,
			`${consumerKey}:entry:${entry.id}`,
			state,
			context,
			fitSeconds,
			fitMode,
			[...ancestry, program.id],
		);
		if (selected) {
			selected.sequenceEntryPath = [entry.id, ...(selected.sequenceEntryPath ?? [])];
			rotation.remaining[index]! -= 1;
			rotation.lastEntry = index;
			value.completed = !config.repeat && rotation.remaining.every((count) => count === 0);
			record.updatedAt = context.now;
			selected.state.set(consumerKey, record);
			return selected;
		}
		if (fitSeconds !== null && fitMode === 'first-fit-arbitrary') {
			return null;
		}
		if (context.blockedPrograms.has(entry.programId)) {
			context.blockedPrograms.add(program.id);
			return null;
		}
		// Keep the current block intact when its next item cannot fit this window.
		if (config.ordering?.type === 'shuffled-blocks' && context.fitRejectionCount > priorFitRejections) {
			return null;
		}

		excluded.add(index);
		// Exhausted children are skipped for this cycle; duration rejection retains the quota.
		if (context.fitRejectionCount === priorFitRejections) {
			rotation.remaining[index] = 0;
			if (config.repeat && rotation.remaining.every((count) => count === 0)) {
				rotation = nextRotation(config, consumerKey, rotation);
				value.rotation = rotation;
			}
		}
	}
	return null;
}

/** Try successful Chance steps in order without rerolling a turn rejected for primary fit. */
function selectChance(
	config: SequenceConfig,
	consumerKey: string,
	state: Map<string, SelectionStateRecord>,
	record: SelectionStateRecord,
	context: SelectionContext,
	fitSeconds: number | null,
	fitMode: SelectionFitMode,
	ancestry: string[],
	selectChild: typeof selectProgram,
): SelectionResult | null {
	const value = record.value as SequenceState;
	const unavailable = new Set<number>();
	let rotation = value.rotation ?? nextRotation(config, consumerKey);

	// An unsuccessful nonempty pass rules out at least one child for this selection.
	while (true) {
		for (const [index, entry] of config.entries.entries()) {
			if (!rotation.remaining[index]) {
				continue;
			}

			const priorFitRejections = context.fitRejectionCount;
			const selected = selectChild(entry.programId, `${consumerKey}:entry:${entry.id}`, state, context, fitSeconds, fitMode, ancestry);
			if (selected) {
				rotation.remaining[index] = 0;
				value.rotation = rotation;
				value.completed = !config.repeat && rotation.remaining.every(count => count === 0);
				record.updatedAt = context.now;
				selected.sequenceEntryPath = [entry.id, ...(selected.sequenceEntryPath ?? [])];
				selected.state.set(consumerKey, record);
				return selected;
			}
			if (context.fitRejectionCount > priorFitRejections) {
				return null;
			}
			rotation.remaining[index] = 0;
			unavailable.add(index);
		}

		if (!config.repeat || !config.entries.some((entry, index) => entry.count > 0 && !unavailable.has(index))) {
			return null;
		}
		rotation = nextRotation(config, consumerKey, rotation, unavailable);
	}
}
