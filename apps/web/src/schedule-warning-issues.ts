import type { TimelineIssue } from '@moirai/shared';

/** Retain the first issue per exact message in display order with a single linear pass. */
export function distinctWarningIssues(issues: readonly TimelineIssue[]): TimelineIssue[] {
	const messages = new Set<string>();
	return issues.filter((issue) => {
		const message = issue.message;
		if (messages.has(message)) {
			return false;
		}

		messages.add(message);
		return true;
	});
}
