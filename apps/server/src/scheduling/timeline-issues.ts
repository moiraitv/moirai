import {
	MAX_TIMELINE_ISSUE_OCCURRENCES,
	MAX_TIMELINE_SEGMENTS,
	type TimelineIssue,
	type TimelineIssueOccurrence,
} from '@moirai/shared';

/** Bound all diagnostic occurrences in one generation or commit, including deduplication state. */
export const MAX_TIMELINE_ISSUE_COUNT_ENTRIES = MAX_TIMELINE_SEGMENTS;

/** Exact interval count and navigation origin for replacement and range-specific detail samples. */
export interface TimelineIssueCount {
	start: string;
	finish: string | null;
	count: number;
	/** Older persisted count indexes omitted the boundary origin. */
	boundaryOrigin?: TimelineIssueOccurrence['boundaryOrigin'];
}

/** Persist partitionable totals without expanding the public occurrence detail list. */
export interface RecordedTimelineIssue extends TimelineIssue {
	occurrenceCounts?: TimelineIssueCount[];
	/** Pre-index counts whose dates cannot be recovered within the retained legacy window. */
	unlocatedOccurrenceCount?: number;
	/** Exclusive end of the last retained range that may contain unlocated legacy occurrences. */
	unlocatedUntil?: string;
}

/** Refuse oversized diagnostics instead of silently discarding partitionable counts. */
export class TimelineIssueLimitError extends Error {
	readonly statusCode = 422;
	readonly expose = true;
	readonly code = 'request_failed';

	constructor() {
		super(`Timeline diagnostics exceed the ${MAX_TIMELINE_ISSUE_COUNT_ENTRIES.toLocaleString('en-US')} total occurrence limit. `
			+ 'Shorten the preview range or resolve recurring schedule warnings.');
		this.name = 'TimelineIssueLimitError';
	}
}

/** Keep issue ownership separate when a template is reused in different layers. */
function issueKey(issue: TimelineIssue): string {
	return JSON.stringify([
		issue.templateId, issue.scheduleLayerId, issue.slotId,
		issue.code, issue.programId, issue.mediaItemId,
	]);
}

/** Match legacy details to count intervals despite timestamp precision differences. */
function intervalKey(entry: Pick<TimelineIssueOccurrence, 'start' | 'finish'>): string {
	return `${Date.parse(entry.start)}:${entry.finish === null ? '' : Date.parse(entry.finish)}`;
}

/** Count exact intervals and retain irrecoverable legacy totals separately. */
function countData(issue: RecordedTimelineIssue): {
	counts: TimelineIssueCount[];
	unlocated: number;
} {
	if (issue.occurrenceCounts) {
		const origins = new Map<string, TimelineIssueOccurrence['boundaryOrigin']>();
		for (const occurrence of issue.occurrences ?? []) {
			const key = intervalKey(occurrence);
			origins.set(key, origins.has(key) && origins.get(key) !== occurrence.boundaryOrigin
				? null : occurrence.boundaryOrigin);
		}
		return {
			counts: issue.occurrenceCounts.map((entry) => entry.boundaryOrigin !== undefined
				? entry : { ...entry, boundaryOrigin: origins.get(intervalKey(entry)) ?? null }),
			unlocated: issue.unlocatedOccurrenceCount ?? 0,
		};
	}

	const occurrences = issue.occurrences ?? [];
	return {
		counts: occurrences.map((occurrence) => ({ ...occurrence, count: 1 })),
		unlocated: Math.max(0, (issue.occurrenceCount ?? Math.max(1, occurrences.length)) - occurrences.length),
	};
}

/** Record each identity once even after its public detail has fallen beyond the sample cap. */
export function recordTimelineIssue(
	issues: RecordedTimelineIssue[],
	seenOccurrences: Set<string>,
	issue: TimelineIssue,
	occurrence: TimelineIssueOccurrence,
	issueIndex: Map<string, RecordedTimelineIssue>,
): void {
	const key = issueKey(issue);
	const occurrenceKey = JSON.stringify([
		key, Date.parse(occurrence.start), occurrence.finish === null ? null : Date.parse(occurrence.finish), occurrence.boundaryOrigin,
	]);
	if (seenOccurrences.has(occurrenceKey)) {
		return;
	}
	if (seenOccurrences.size >= MAX_TIMELINE_ISSUE_COUNT_ENTRIES) {
		throw new TimelineIssueLimitError();
	}

	let existing = issueIndex.get(key);
	if (!existing) {
		existing = { ...issue, occurrences: [], occurrenceCount: 0, occurrenceCounts: [] };
		issues.push(existing);
		issueIndex.set(key, existing);
	}
	const counts = existing.occurrenceCounts!;
	const last = counts.at(-1);
	if (last?.start === occurrence.start && last.finish === occurrence.finish
		&& last.boundaryOrigin === occurrence.boundaryOrigin) {
		last.count += 1;
	}
	else {
		if (counts.length >= MAX_TIMELINE_ISSUE_COUNT_ENTRIES) {
			throw new TimelineIssueLimitError();
		}
		counts.push({ ...occurrence, count: 1 });
	}

	seenOccurrences.add(occurrenceKey);
	existing.occurrenceCount! += 1;
	if (existing.occurrences!.length < MAX_TIMELINE_ISSUE_OCCURRENCES) {
		existing.occurrences!.push(occurrence);
	}
}

/** Intersect interval warnings with a retained range; point warnings use a half-open time test. */
function clipInterval<T extends { start: string; finish: string | null }>(
	entry: T,
	start: string,
	finish: string,
): T[] {
	const startMs = Date.parse(start);
	const finishMs = Date.parse(finish);
	const entryStart = Date.parse(entry.start);
	if (entry.finish === null) {
		return entryStart >= startMs && entryStart < finishMs ? [entry] : [];
	}
	const entryFinish = Date.parse(entry.finish);
	if (entryStart >= finishMs || entryFinish <= startMs) {
		return [];
	}
	return [{
		...entry,
		start: entryStart < startMs ? start : entry.start,
		finish: entryFinish > finishMs ? finish : entry.finish,
	}];
}

/** Sort variable-precision engine timestamps by their millisecond-backed instant. */
function chronologicalStart(left: { start: string }, right: { start: string }): number {
	return Date.parse(left.start) - Date.parse(right.start);
}

/** Rebuild a bounded chronological detail sample from the retained interval index. */
function occurrenceSample(counts: TimelineIssueCount[]): TimelineIssueOccurrence[] {
	return [...counts].sort(chronologicalStart).slice(0, MAX_TIMELINE_ISSUE_OCCURRENCES)
		.map(({ start, finish, boundaryOrigin }) => ({ start, finish, boundaryOrigin: boundaryOrigin ?? null }));
}

/** Strip persistence-only indexes from public preview and guide responses. */
export function publicTimelineIssue(issue: RecordedTimelineIssue): TimelineIssue {
	const publicIssue = { ...issue };
	delete publicIssue.occurrenceCounts;
	delete publicIssue.unlocatedOccurrenceCount;
	delete publicIssue.unlocatedUntil;
	return publicIssue;
}

/** Merge exact counts from disjoint retained and regenerated ranges, with capped details. */
export function mergeTimelineIssues(
	existing: RecordedTimelineIssue[],
	generated: RecordedTimelineIssue[],
	windowStart: string,
	replaceFrom: string,
	windowEnd: string,
): RecordedTimelineIssue[] {
	const merged = new Map<string, RecordedTimelineIssue>();
	let occurrenceTotal = 0;
	const append = (issue: RecordedTimelineIssue, start: string, finish: string): void => {
		if (Date.parse(start) >= Date.parse(finish)) {
			return;
		}

		const data = countData(issue);
		const counts = data.counts.flatMap((count) => clipInterval(count, start, finish));
		const unlocatedUntil = issue.unlocatedUntil && Date.parse(issue.unlocatedUntil) < Date.parse(finish)
			? issue.unlocatedUntil : finish;
		const unlocated = Date.parse(unlocatedUntil) > Date.parse(start) ? data.unlocated : 0;
		const total = counts.reduce((sum, count) => sum + count.count, unlocated);
		if (total === 0) {
			return;
		}
		if (occurrenceTotal + total > MAX_TIMELINE_ISSUE_COUNT_ENTRIES) {
			throw new TimelineIssueLimitError();
		}
		occurrenceTotal += total;
		const key = issueKey(issue);
		const current = merged.get(key);
		const combinedUntil = unlocated > 0 && (!current?.unlocatedUntil || Date.parse(unlocatedUntil) > Date.parse(current.unlocatedUntil))
			? unlocatedUntil : current?.unlocatedUntil;
		const combinedCounts = [...(current?.occurrenceCounts ?? []), ...counts];
		if (combinedCounts.length > MAX_TIMELINE_ISSUE_COUNT_ENTRIES) {
			throw new TimelineIssueLimitError();
		}
		merged.set(key, {
			...publicTimelineIssue(issue),
			occurrenceCounts: combinedCounts.sort(chronologicalStart),
			unlocatedOccurrenceCount: (current?.unlocatedOccurrenceCount ?? 0) + unlocated,
			...(combinedUntil ? { unlocatedUntil: combinedUntil } : {}),
			occurrenceCount: (current?.occurrenceCount ?? 0) + total,
			occurrences: occurrenceSample(combinedCounts),
		});
	};

	for (const issue of existing) {
		append(issue, windowStart, replaceFrom);
	}
	for (const issue of generated) {
		append(issue, replaceFrom, windowEnd);
	}
	return [...merged.values()];
}

/** Filter public guide warnings by exact interval counts, preserving unlocated legacy warnings. */
export function timelineIssuesInRange(
	issues: RecordedTimelineIssue[],
	rangeStart: string,
	rangeEnd: string,
): TimelineIssue[] {
	if (Date.parse(rangeStart) >= Date.parse(rangeEnd)) {
		return [];
	}
	return issues.flatMap((issue) => {
		const data = countData(issue);
		const unlocated = issue.unlocatedUntil && Date.parse(rangeStart) >= Date.parse(issue.unlocatedUntil) ? 0 : data.unlocated;
		const counts = data.counts.flatMap((entry) => clipInterval(entry, rangeStart, rangeEnd));
		const count = counts.reduce((sum, entry) => sum + entry.count, unlocated);
		if (count === 0) {
			return [];
		}
		return [{
			...publicTimelineIssue(issue),
			occurrences: occurrenceSample(counts),
			occurrenceCount: count,
		}];
	});
}
