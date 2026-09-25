import { createHash } from 'node:crypto';
import type { SchedulingProgram, SelectionStateRecord, SelectionStateValue } from '@moirai/shared';
import type { SelectionContext, SelectionFitMode, SelectionResult, selectProgram } from './selection.js';

/** Persisted parent progress; child cursors remain independently keyed by entry identity. */
type SequenceState = Extract<SelectionStateValue, { type: 'sequence' }>;

/** Reproducible unit interval for parent selection, without mutable global randomness. */
function randomUnit(seed: string): number {
	return createHash('sha256').update(seed).digest().readUInt32BE(0) / 0x100000000;
}

/** Select counted child media while committing parent progress only with a successful result. */
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
	const value = record.value as Extract<SelectionStateValue, { type: 'sequence' }>;
	if (value.completed) {
		return null;
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

/** Choose a quota-bearing entry using block order, random allocation, or proportional deficit. */
function rotationEntry(
	config: Extract<SchedulingProgram['config'], { type: 'sequence' }>,
	rotation: NonNullable<SequenceState['rotation']>,
	consumerKey: string,
	excluded: Set<number>,
): number | undefined {
	let eligible = rotation.remaining.flatMap((count, index) => count > 0 && !excluded.has(index) ? [index] : []);
	if (config.ordering?.type === 'shuffled-blocks') {
		return rotation.order.find((index) => eligible.includes(index));
	}
	const total = config.entries.reduce((sum, entry) => sum + entry.count, 0);
	const consumed = total - rotation.remaining.reduce((sum, count) => sum + count, 0);
	if (config.ordering?.type === 'balanced-rotation') {
		if (eligible.some((index) => index !== rotation.lastEntry)) {
			eligible = eligible.filter((index) => index !== rotation.lastEntry);
		}
		return eligible.sort((a, b) => {
			const deficit = (index: number): number => (consumed + 1) * config.entries[index]!.count
				- (config.entries[index]!.count - rotation.remaining[index]!) * total;
			return deficit(b) - deficit(a) || a - b;
		})[0];
	}

	const seed = config.ordering && 'seed' in config.ordering ? config.ordering.seed : '';
	let ticket = randomUnit(`${seed}:${consumerKey}:${rotation.cycle}:${consumed}`)
		* eligible.reduce((sum, index) => sum + rotation.remaining[index]!, 0);
	return eligible.find((index) => {
		ticket -= rotation.remaining[index]!;
		return ticket < 0;
	});
}

/** Advance one non-ordered cycle with state bounded by the number of authored entries. */
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
			return null;
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

/** Begin a cycle without resetting the independently persisted child selections. */
function nextRotation(
	config: Extract<SchedulingProgram['config'], { type: 'sequence' }>,
	consumerKey: string,
	prior: SequenceState['rotation'],
): NonNullable<SequenceState['rotation']> {
	const cycle = prior ? prior.cycle + 1 : 0;
	const seed = config.ordering && 'seed' in config.ordering ? config.ordering.seed : '';
	return {
		cycle,
		remaining: config.entries.map((entry) => entry.count),
		order: config.entries.map((_, index) => index).sort((a, b) =>
			randomUnit(`${seed}:${consumerKey}:${cycle}:${config.entries[a]!.id}`)
			- randomUnit(`${seed}:${consumerKey}:${cycle}:${config.entries[b]!.id}`) || a - b),
		lastEntry: prior?.lastEntry ?? null,
	};
}
