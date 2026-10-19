import { isRemovalScanIssue, scanIssueRequiresAttention, type Library, type ReconciliationStatus, type ScanIssue, type ScanRun } from '@moirai/shared';

/** Candidate-source findings cannot change media-issue decisions until the source is accepted. */
export function scanIssuesRequireSourceApproval(issues: readonly ScanIssue[]): boolean {
	return issues.some(issue => [
		'source_change_requires_approval', 'source_identity_requires_approval', 'source_candidate_incomplete',
	].includes(issue.code));
}

/** Source-approval notices are presented by the dedicated reconciliation banner. */
const SOURCE_APPROVAL_NOTICE_CODES = new Set(['source_change_requires_approval', 'source_identity_requires_approval']);

/** Keep scan failures visible without duplicating notices covered by an active reconciliation banner. */
export function libraryScanAttention(
	library: Pick<Library, 'warningCount' | 'pendingRemovalCount'> | undefined,
	scans: readonly Pick<ScanRun, 'status' | 'issues'>[],
	reconciliationStatus: ReconciliationStatus = 'idle',
) {
	if (!library?.warningCount) {
		return { count: 0, issues: [] };
	}

	const latest = scans.find(scan => scan.status !== 'running');
	if (!latest?.issues.length) {
		return { count: library.warningCount, issues: [] };
	}

	const reconciliationVisible = reconciliationStatus !== 'idle';
	const issues = latest.issues.filter(issue => scanIssueRequiresAttention(issue)
		&& (library.pendingRemovalCount > 0 || !isRemovalScanIssue(issue))
		&& !(reconciliationVisible && (isRemovalScanIssue(issue) || SOURCE_APPROVAL_NOTICE_CODES.has(issue.code))));
	return { count: Math.min(library.warningCount, issues.length), issues };
}
