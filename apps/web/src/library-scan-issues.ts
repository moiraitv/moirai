import { isRemovalScanIssue, isSuppressedScanIssue, type Library, type ScanIssue, type ScanRun } from '@moirai/shared';

/** Candidate-source findings cannot change media-issue decisions until the source is accepted. */
export function scanIssuesRequireSourceApproval(issues: readonly ScanIssue[]): boolean {
	return issues.some(issue => [
		'source_change_requires_approval', 'source_identity_requires_approval', 'source_candidate_incomplete',
	].includes(issue.code));
}

/** Show current actionable scan issues while preserving historical diagnostics in scan history. */
export function libraryScanAttention(
	library: Pick<Library, 'warningCount' | 'pendingRemovalCount'> | undefined,
	scans: readonly Pick<ScanRun, 'status' | 'issues'>[],
) {
	if (!library?.warningCount) {
		return { count: 0, issues: [] };
	}

	const latest = scans.find(scan => scan.status !== 'running');
	if (!latest?.issues.length) {
		return { count: library.warningCount, issues: [] };
	}

	const issues = latest.issues.filter(issue => !isSuppressedScanIssue(issue)
		&& (library.pendingRemovalCount > 0 || !isRemovalScanIssue(issue)));
	return { count: Math.min(library.warningCount, issues.length), issues };
}
