/** A timestamped listing retained by reference in a searchable guide snapshot. */
export interface GuideInterval {
	id: string;
	start: string;
	finish: string;
}

/** Parsed interval whose subtree end bounds allow overlapping listings to be skipped safely. */
interface IndexedInterval<T> {
	value: T;
	start: number;
	finish: number;
	maximumFinish: number;
}

/**
 * Index immutable channel listings once, independent of viewport size and zoom.
 * Balanced subtree bounds preserve long and overlapping entries without scanning the whole week.
 */
export class GuideIntervalIndex<T extends GuideInterval> {
	private readonly entries: IndexedInterval<T>[];

	constructor(values: readonly T[]) {
		this.entries = values.map(value => ({
			value, start: Date.parse(value.start), finish: Date.parse(value.finish), maximumFinish: 0,
		}));
		if (this.entries.some((entry, index) => index > 0 && entry.start < this.entries[index - 1]!.start)) {
			this.entries.sort((left, right) => left.start - right.start);
		}
		this.buildBounds(0, this.entries.length);
	}

	/** Record each balanced subtree's latest finish for overlap pruning. */
	private buildBounds(start: number, end: number): number {
		if (start >= end) {
			return Number.NEGATIVE_INFINITY;
		}
		const middle = (start + end) >>> 1;
		const entry = this.entries[middle]!;
		entry.maximumFinish = Math.max(entry.finish, this.buildBounds(start, middle), this.buildBounds(middle + 1, end));
		return entry.maximumFinish;
	}

	/** Return chronological overlaps, including tiny intervals drawn at a minimum pixel width. */
	query(start: number, finish: number, minimumDuration = 0): T[] {
		const output: T[] = [];
		if (finish > start) {
			this.collect(0, this.entries.length, start, finish, minimumDuration, output);
		}
		return output;
	}

	/** Visit only subtrees that can intersect the requested interval. */
	private collect(low: number, high: number, start: number, finish: number, minimum: number, output: T[]): void {
		if (low >= high) {
			return;
		}
		const middle = (low + high) >>> 1;
		const entry = this.entries[middle]!;
		if (entry.maximumFinish + minimum <= start) {
			return;
		}
		this.collect(low, middle, start, finish, minimum, output);
		if (entry.start >= finish) {
			return;
		}
		if (Math.max(entry.finish, entry.start + minimum) > start) {
			output.push(entry.value);
		}
		this.collect(middle + 1, high, start, finish, minimum, output);
	}
}

/** Weak ownership permits remount reuse without retaining replaced guide snapshots. */
const indexes = new WeakMap<readonly GuideInterval[], GuideIntervalIndex<GuideInterval>>();

/** Reuse a channel index until its immutable listing array is replaced. */
export function guideIntervalIndex<T extends GuideInterval>(values: readonly T[]): GuideIntervalIndex<T> {
	let index = indexes.get(values);
	if (!index) {
		index = new GuideIntervalIndex(values);
		indexes.set(values, index);
	}
	return index as GuideIntervalIndex<T>;
}
