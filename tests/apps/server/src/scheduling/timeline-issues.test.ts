import { describe, expect, it } from 'vitest';
import { MAX_TIMELINE_ISSUE_OCCURRENCES, type TimelineIssue } from '@moirai/shared';
import {
	MAX_TIMELINE_ISSUE_COUNT_ENTRIES,
	mergeTimelineIssues,
	publicTimelineIssue,
	recordTimelineIssue,
	timelineIssuesInRange,
	TimelineIssueLimitError,
	type RecordedTimelineIssue,
} from '@server/scheduling/timeline-issues.js';

const issue: TimelineIssue = {
	code: 'boundary-start-rejected',
	message: 'Boundary rejected an item.',
	templateId: 'template',
	scheduleLayerId: 'layer',
	slotId: 'slot',
	programId: 'program',
	mediaItemId: null,
};
const origin = Date.parse('2026-08-01T00:00:00Z');
const instant = (hour: number): string => new Date(origin + hour * 3_600_000).toISOString();

function recurringIssues(start: number, finish: number): RecordedTimelineIssue[] {
	const issues: RecordedTimelineIssue[] = [];
	const seen = new Set<string>();
	const index = new Map<string, RecordedTimelineIssue>();
	for (let hour = start; hour < finish; hour += 1) {
		const occurrence = { start: instant(hour), finish: instant(hour + 0.5), boundaryOrigin: 'layer-entry' as const };
		recordTimelineIssue(issues, seen, issue, occurrence, index);
		// Fit-then-fallback may report the same problem at the same cursor twice.
		recordTimelineIssue(issues, seen, issue, { ...occurrence }, index);
	}
	return JSON.parse(JSON.stringify(issues)) as RecordedTimelineIssue[];
}

describe('partitionable timeline issue counts', () => {
	it('bounds all issue identities, count records, and deduplication keys together', () => {
		const issues: RecordedTimelineIssue[] = [];
		const seen = new Set<string>();
		const index = new Map<string, RecordedTimelineIssue>();
		const occurrence = { start: instant(0), finish: null, boundaryOrigin: null };
		for (let item = 0; item < MAX_TIMELINE_ISSUE_COUNT_ENTRIES; item += 1) {
			recordTimelineIssue(issues, seen, { ...issue, mediaItemId: `media-${item}` }, occurrence, index);
		}
		expect(() => recordTimelineIssue(issues, seen, { ...issue, mediaItemId: 'media-over-budget' }, occurrence, index))
			.toThrow(TimelineIssueLimitError);
		// A duplicate remains harmless even at the aggregate limit.
		recordTimelineIssue(issues, seen, { ...issue, mediaItemId: 'media-0' }, occurrence, index);
		expect(issues).toHaveLength(MAX_TIMELINE_ISSUE_COUNT_ENTRIES);
		expect(seen.size).toBe(MAX_TIMELINE_ISSUE_COUNT_ENTRIES);
		expect(index.size).toBe(MAX_TIMELINE_ISSUE_COUNT_ENTRIES);
		expect(issues.reduce((total, entry) => total + entry.occurrenceCount!, 0)).toBe(MAX_TIMELINE_ISSUE_COUNT_ENTRIES);
	});

	it('enforces the aggregate budget when individually valid retained and regenerated issues are merged', () => {
		const half = MAX_TIMELINE_ISSUE_COUNT_ENTRIES / 2;
		const retained = recurringIssues(0, half);
		const regenerated = recurringIssues(half, MAX_TIMELINE_ISSUE_COUNT_ENTRIES);
		regenerated[0]!.mediaItemId = 'different-issue';
		const merged = mergeTimelineIssues(retained, regenerated, instant(0), instant(half), instant(MAX_TIMELINE_ISSUE_COUNT_ENTRIES));
		expect(merged).toHaveLength(2);
		expect(merged.reduce((total, entry) => total + entry.occurrenceCount!, 0)).toBe(MAX_TIMELINE_ISSUE_COUNT_ENTRIES);
		const excess = recurringIssues(MAX_TIMELINE_ISSUE_COUNT_ENTRIES, MAX_TIMELINE_ISSUE_COUNT_ENTRIES + 1);
		excess[0]!.mediaItemId = 'one-more-issue';
		expect(() => mergeTimelineIssues(retained, [...regenerated, ...excess], instant(0), instant(half), instant(MAX_TIMELINE_ISSUE_COUNT_ENTRIES + 1))).toThrow(TimelineIssueLimitError);
	});

	it('clips retained intervals at both window edges and at a partial repair', () => {
		const legacy: RecordedTimelineIssue = {
			...issue,
			occurrences: [{ start: instant(19), finish: instant(24), boundaryOrigin: 'template' }],
			occurrenceCount: 1,
		};
		const retained = mergeTimelineIssues([legacy], [], instant(19.5), instant(20), instant(24));
		expect(retained[0]?.occurrences).toEqual([{ start: instant(19.5), finish: instant(20), boundaryOrigin: 'template' }]);
		expect(retained[0]?.occurrenceCounts).toEqual([{ start: instant(19.5), finish: instant(20), boundaryOrigin: 'template', count: 1 }]);
		expect(timelineIssuesInRange(retained, instant(20), instant(24))).toEqual([]);
		expect(timelineIssuesInRange(retained, instant(19.75), instant(20))[0]?.occurrences?.[0]?.start).toBe(instant(19.75));
	});

	it('orders and retains variable-precision timestamps chronologically, including equivalent instants', () => {
		const issues: RecordedTimelineIssue[] = [];
		const seen = new Set<string>();
		const index = new Map<string, RecordedTimelineIssue>();
		for (const start of ['2026-09-02T00:00:00.5Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00.500Z']) {
			recordTimelineIssue(issues, seen, issue, { start, finish: null, boundaryOrigin: null }, index);
		}
		expect(issues[0]?.occurrenceCount).toBe(2);
		const merged = mergeTimelineIssues([], issues, '2026-09-02T00:00:00Z', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:01Z');
		expect(merged[0]?.occurrences?.map((entry) => entry.start)).toEqual(['2026-09-02T00:00:00Z', '2026-09-02T00:00:00.5Z']);
		expect(timelineIssuesInRange(merged, '2026-09-02T00:00:00Z', '2026-09-02T00:00:01Z')[0]?.occurrenceCount).toBe(2);
		expect(timelineIssuesInRange(merged, '2026-09-02T00:00:00.1Z', '2026-09-02T00:00:00.9Z')[0]?.occurrenceCount).toBe(1);
		expect(timelineIssuesInRange(merged, '2026-09-02T00:00:00Z', '2026-09-02T00:00:00.000Z')).toEqual([]);
	});

	it('deduplicates reports after the public detail cap while preserving exact totals', () => {
		const issues = recurringIssues(0, MAX_TIMELINE_ISSUE_OCCURRENCES + 20);
		expect(issues[0]?.occurrences).toHaveLength(MAX_TIMELINE_ISSUE_OCCURRENCES);
		expect(issues[0]?.occurrenceCount).toBe(MAX_TIMELINE_ISSUE_OCCURRENCES + 20);
		expect(issues[0]?.occurrenceCounts).toHaveLength(MAX_TIMELINE_ISSUE_OCCURRENCES + 20);
		expect(publicTimelineIssue(issues[0]!)).not.toHaveProperty('occurrenceCounts');
	});

	it('returns a range-specific sample with the exact origins after the original details are capped', () => {
		const issues: RecordedTimelineIssue[] = [];
		const seen = new Set<string>();
		const index = new Map<string, RecordedTimelineIssue>();
		for (let hour = 0; hour < 7 * 24; hour += 1) {
			recordTimelineIssue(issues, seen, issue, {
				start: instant(hour), finish: instant(hour + 0.5),
				boundaryOrigin: hour < 72 ? 'layer-entry' : 'layer-exit',
			}, index);
		}
		const persisted = JSON.parse(JSON.stringify(issues)) as RecordedTimelineIssue[];
		const dayFour = timelineIssuesInRange(persisted, instant(72), instant(96))[0]!;
		expect(dayFour.occurrenceCount).toBe(24);
		expect(dayFour.occurrences).toEqual(Array.from({ length: 24 }, (_, offset) => ({
			start: instant(72 + offset), finish: instant(72.5 + offset), boundaryOrigin: 'layer-exit',
		})));
		expect(dayFour).not.toHaveProperty('occurrenceCounts');
		const rolled = mergeTimelineIssues(persisted, [], instant(72), instant(168), instant(168));
		expect(rolled[0]?.occurrences).toHaveLength(MAX_TIMELINE_ISSUE_OCCURRENCES);
		expect(rolled[0]?.occurrences?.[0]).toEqual(dayFour.occurrences?.[0]);
		expect(timelineIssuesInRange(rolled, instant(72.25), instant(72.4))[0]?.occurrences)
			.toEqual([{ start: instant(72.25), finish: instant(72.4), boundaryOrigin: 'layer-exit' }]);
	});

	it('preserves distinct boundary origins at the same interval even beyond the detail cap', () => {
		const issues = recurringIssues(0, MAX_TIMELINE_ISSUE_OCCURRENCES);
		const seen = new Set<string>();
		const index = new Map<string, RecordedTimelineIssue>();
		const later: RecordedTimelineIssue[] = [];
		for (const boundaryOrigin of ['layer-entry', 'layer-exit'] as const) {
			const occurrence = { start: instant(72), finish: instant(72.5), boundaryOrigin };
			recordTimelineIssue(later, seen, issue, occurrence, index);
			recordTimelineIssue(later, seen, issue, occurrence, index);
		}
		const merged = mergeTimelineIssues(issues, later, instant(0), instant(72), instant(96));
		const sampled = timelineIssuesInRange(merged, instant(72), instant(96))[0]!;
		expect(sampled.occurrenceCount).toBe(2);
		expect(sampled.occurrences?.map((entry) => entry.boundaryOrigin)).toEqual(['layer-entry', 'layer-exit']);
	});

	it('reads prior count indexes without inventing missing origins or losing known details', () => {
		const prior = recurringIssues(0, 168);
		for (const count of prior[0]!.occurrenceCounts!) {
			delete count.boundaryOrigin;
		}
		const restored = JSON.parse(JSON.stringify(prior)) as RecordedTimelineIssue[];
		expect(timelineIssuesInRange(restored, instant(0), instant(1))[0]?.occurrences)
			.toEqual([{ start: instant(0), finish: instant(0.5), boundaryOrigin: 'layer-entry' }]);
		const dayFour = timelineIssuesInRange(restored, instant(72), instant(96))[0]!;
		expect(dayFour.occurrenceCount).toBe(24);
		expect(dayFour.occurrences).toHaveLength(24);
		expect(dayFour.occurrences?.[0]).toEqual({ start: instant(72), finish: instant(72.5), boundaryOrigin: null });
	});

	it('keeps exact week totals through repeated daily rolls after every original detail ages out', () => {
		let issues = recurringIssues(0, 7 * 24);
		for (let day = 1; day <= 8; day += 1) {
			const start = day * 24;
			const replaceFrom = (day + 6) * 24;
			const end = (day + 7) * 24;
			issues = mergeTimelineIssues(issues, recurringIssues(replaceFrom, end), instant(start), instant(replaceFrom), instant(end));
			issues = JSON.parse(JSON.stringify(issues)) as RecordedTimelineIssue[];
			expect(issues[0]?.occurrenceCount).toBe(7 * 24);
			expect(issues[0]?.occurrenceCounts).toHaveLength(7 * 24);
			expect(issues[0]?.occurrences!.length).toBeLessThanOrEqual(MAX_TIMELINE_ISSUE_OCCURRENCES);
			const laterDay = timelineIssuesInRange(issues, instant(start + 4 * 24), instant(start + 5 * 24))[0]!;
			expect(laterDay.occurrenceCount).toBe(24);
			expect(laterDay.occurrences).toHaveLength(24);
			expect(laterDay.occurrences?.[0]?.boundaryOrigin).toBe('layer-entry');
		}
	});

	it('partitions hidden counts at a mid-day replacement cursor and prunes both window edges', () => {
		const merged = mergeTimelineIssues(
			recurringIssues(0, 168),
			recurringIssues(100, 192),
			instant(60),
			instant(100.5),
			instant(180),
		);
		expect(merged[0]?.occurrenceCount).toBe(120);
		expect(merged[0]?.occurrenceCounts?.map((entry) => entry.start))
			.toEqual(Array.from({ length: 120 }, (_, index) => instant(index + 60)));
		expect(timelineIssuesInRange(merged, instant(190), instant(191))).toEqual([]);
	});

	it('retains unlocated legacy counts only until regeneration or the legacy window ages out', () => {
		const legacy: RecordedTimelineIssue = {
			...issue,
			occurrences: [{ start: instant(0), finish: null, boundaryOrigin: 'layer-entry' }],
			occurrenceCount: 75,
		};
		const partial = mergeTimelineIssues([legacy], [], instant(24), instant(168), instant(192));
		expect(partial[0]?.occurrenceCount).toBe(74);
		expect(partial[0]?.unlocatedOccurrenceCount).toBe(74);
		expect(partial[0]?.unlocatedUntil).toBe(instant(168));
		expect(timelineIssuesInRange(partial, instant(48), instant(72))[0]?.occurrenceCount).toBe(74);
		expect(timelineIssuesInRange(partial, instant(168), instant(192))).toEqual([]);
		expect(mergeTimelineIssues(partial, [], instant(168), instant(192), instant(216))).toEqual([]);
		expect(mergeTimelineIssues(partial, [], instant(24), instant(24), instant(192))).toEqual([]);
		const mixed = mergeTimelineIssues(partial, recurringIssues(168, 192), instant(24), instant(168), instant(192));
		expect(mixed[0]?.unlocatedUntil).toBe(instant(168));
		expect(mixed[0]?.occurrenceCount).toBe(74 + 24);
		expect(mergeTimelineIssues(mixed, recurringIssues(192, 216), instant(168), instant(192), instant(216))[0]?.occurrenceCount)
			.toBe(48);
	});

	it('rejects an oversized count index instead of silently truncating its exact totals', () => {
		const full: RecordedTimelineIssue = {
			...issue,
			occurrences: [],
			occurrenceCount: MAX_TIMELINE_ISSUE_COUNT_ENTRIES,
			occurrenceCounts: Array.from({ length: MAX_TIMELINE_ISSUE_COUNT_ENTRIES }, (_, hour) => ({
				start: instant(hour), finish: null, count: 1,
			})),
		};
		const next = MAX_TIMELINE_ISSUE_COUNT_ENTRIES;
		const index = new Map<string, RecordedTimelineIssue>();
		const seeded: RecordedTimelineIssue[] = [];
		recordTimelineIssue(seeded, new Set(), issue, { start: instant(0), finish: null, boundaryOrigin: null }, index);
		Object.assign(seeded[0]!, full);
		expect(() => recordTimelineIssue(seeded, new Set(), issue, {
			start: instant(next), finish: null, boundaryOrigin: 'layer-entry',
		}, index)).toThrow(TimelineIssueLimitError);
		expect(() => mergeTimelineIssues([full], recurringIssues(next, next + 1), instant(0), instant(next), instant(next + 1))).toThrow(TimelineIssueLimitError);
	});
});
