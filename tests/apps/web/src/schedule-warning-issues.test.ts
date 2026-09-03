import { describe, expect, it } from 'vitest';
import type { TimelineIssue } from '@moirai/shared';
import { distinctWarningIssues } from '@web/schedule-warning-issues';

function issue(message: string, mediaItemId: string): TimelineIssue {
	return {
		code: 'media-duration-missing', message, mediaItemId,
		templateId: 'template', slotId: 'slot', programId: 'program', scheduleLayerId: null,
	};
}

describe('warning message deduplication', () => {
	it('retains the first issue and its metadata in original message order without mutating input', () => {
		const first = Object.freeze({
			...issue('Missing duration', 'first'), occurrenceCount: 2,
			occurrences: [{ start: '2026-09-02T00:00:00Z', finish: null, boundaryOrigin: null }],
		});
		const second = Object.freeze(issue('Unavailable source', 'second'));
		const duplicate = Object.freeze({ ...issue(first.message, 'later'), occurrenceCount: 10 });
		const differentCase = Object.freeze(issue('missing duration', 'lowercase'));
		const input = Object.freeze([first, second, duplicate, differentCase, second]);
		const result = distinctWarningIssues(input);

		expect(result).toEqual([first, second, differentCase]);
		expect(result[0]).toBe(first);
		expect(result[1]).toBe(second);
		expect(result[2]).toBe(differentCase);
	});

	it('handles an empty diagnostic set', () => {
		expect(distinctWarningIssues([])).toEqual([]);
	});

	it('reads each message once for a large distinct diagnostic set', () => {
		let messageReads = 0;
		const issues = Array.from({ length: 25_000 }, (_, index) => ({
			...issue('', String(index)),
			get message() {
				messageReads += 1;
				return `Missing duration for media ${index}`;
			},
		}));
		const result = distinctWarningIssues(issues);

		// Count property reads instead of using a machine-dependent timing threshold.
		expect(messageReads).toBe(issues.length);
		expect(result).toHaveLength(issues.length);
		expect(result.every((entry, index) => entry === issues[index])).toBe(true);
	});
});
