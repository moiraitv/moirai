import { createHash } from 'node:crypto';
import type { SchedulingProgram, SelectionStateValue } from '@moirai/shared';

/** Sequence configuration shared by primary and filler selection. */
export type SequenceConfig = Extract<SchedulingProgram['config'], { type: 'sequence' }>;

/** Persisted parent progress; child cursors remain independently keyed by entry identity. */
export type SequenceState = Extract<SelectionStateValue, { type: 'sequence' }>;

/** Allocations remaining in one parent cycle, including any carried filler turns. */
export type SequenceRotation = NonNullable<SequenceState['rotation']>;

/** Reproducible unit interval for parent selection, without mutable global randomness. */
function randomUnit(seed: string): number {
	return createHash('sha256').update(seed).digest().readUInt32BE(0) / 0x100000000;
}

/** Choose a pending turn using the ordering rule and this attempt’s exclusions. */
export function rotationEntry(
	config: SequenceConfig,
	rotation: SequenceRotation,
	consumerKey: string,
	excluded: Set<number>,
): number | undefined {
	let eligible = rotation.remaining.flatMap((count, index) => count > 0 && !excluded.has(index) ? [index] : []);
	if (config.ordering?.type === 'shuffled-blocks') {
		return rotation.order.find((index) => eligible.includes(index));
	}
	if (!config.ordering || config.ordering.type === 'ordered' || config.ordering.type === 'chance') {
		return eligible[0];
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

/** Begin a cycle without resetting the independently persisted child selections. */
export function nextRotation(
	config: SequenceConfig,
	consumerKey: string,
	prior?: SequenceRotation,
	excluded: ReadonlySet<number> = new Set(),
): SequenceRotation {
	const cycle = prior ? prior.cycle + 1 : 0;
	const seed = config.ordering && 'seed' in config.ordering ? config.ordering.seed : '';
	if (config.ordering?.type === 'chance') {
		return chanceRotation(config, `${seed}:${consumerKey}:chance`, cycle, excluded);
	}

	const order = config.ordering && config.ordering.type !== 'ordered'
		? config.entries.map((entry, index) => ({ index, key: randomUnit(`${seed}:${consumerKey}:${cycle}:${entry.id}`) }))
			.sort((left, right) => left.key - right.key || left.index - right.index).map(entry => entry.index)
		: [];
	return {
		cycle,
		remaining: config.entries.map((entry, index) => excluded.has(index) ? 0 : entry.count),
		order,
		lastEntry: prior?.lastEntry ?? null,
	};
}

/** Sample independent Bernoulli steps and jump past empty repeat cycles in one pass. */
function chanceRotation(config: SequenceConfig, seed: string, start: number, excluded: ReadonlySet<number>): SequenceRotation {
	const chances = config.entries.map((entry, index) => excluded.has(index) ? 0 : entry.count / 100);
	const rotation: SequenceRotation = { cycle: start, remaining: chances.map(() => 0), order: [], lastEntry: null };
	if (!chances.some(chance => chance > 0)) {
		return rotation;
	}

	// Skip geometrically distributed empty passes, then condition each roll until the first hit.
	const logEmpty = new Array<number>(chances.length + 1);
	logEmpty[chances.length] = 0;
	for (let index = chances.length - 1; index >= 0; index -= 1) {
		logEmpty[index] = Math.log1p(-chances[index]!) + logEmpty[index + 1]!;
	}
	let needsHit = config.repeat;
	if (needsHit) {
		rotation.cycle += Math.floor(Math.log1p(-randomUnit(`${seed}:${start}:empty`)) / logEmpty[0]!);
	}
	for (const [index, chance] of chances.entries()) {
		if (chance === 0) {
			continue;
		}
		const probability = needsHit ? Math.min(1, chance / -Math.expm1(logEmpty[index]!)) : chance;
		if (probability === 1 || randomUnit(`${seed}:${rotation.cycle}:${config.entries[index]!.id}`) >= 1 - probability) {
			rotation.remaining[index] = 1;
			needsHit = false;
		}
	}
	return rotation;
}
