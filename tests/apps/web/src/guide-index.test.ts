import { describe, expect, it } from 'vitest';
import { GuideIntervalIndex, guideIntervalIndex } from '@web/guide-index';

function interval(id: string, start: number, finish: number) {
	return { id, start: new Date(start).toISOString(), finish: new Date(finish).toISOString() };
}

describe('guide interval selection', () => {
	it('keeps overlapping and long entries, sorts unordered input, and excludes touching boundaries', () => {
		const entries = [interval('later', 60, 80), interval('long', 0, 100), interval('middle', 30, 50), interval('early', 10, 20)];
		const index = new GuideIntervalIndex(entries);
		expect(index.query(20, 60).map(entry => entry.id)).toEqual(['long', 'middle']);
		expect(index.query(100, 110)).toEqual([]);
		expect(index.query(20, 20)).toEqual([]);
	});

	it('preserves the minimum drawn width and original object identity', () => {
		const entry = interval('short', 0, 1);
		const index = new GuideIntervalIndex([entry]);
		expect(index.query(2, 4, 3)).toEqual([entry]);
		expect(index.query(2, 4, 3)[0]).toBe(entry);
		expect(index.query(3, 4, 3)).toEqual([]);
	});

	it('matches a full overlap scan across deterministic irregular intervals', () => {
		const entries = Array.from({ length: 2000 }, (_, i) => interval(String(i), i * 10, i * 10 + (i % 97) * 13 + 1));
		const index = new GuideIntervalIndex(entries);
		for (let start = 0; start < 20000; start += 137) {
			expect(index.query(start, start + 80)).toEqual(entries.filter(entry => Date.parse(entry.start) < start + 80 && Date.parse(entry.finish) > start));
		}
	});

	it('reuses an immutable snapshot index without reusing a replaced array', () => {
		const values = [interval('one', 0, 1)];
		expect(guideIntervalIndex(values)).toBe(guideIntervalIndex(values));
		expect(guideIntervalIndex([...values])).not.toBe(guideIntervalIndex(values));
	});
});
