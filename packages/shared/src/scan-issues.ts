import type { ScanIssue } from './index.js';

/** Identify scan diagnostics that stop requiring attention once missing-item reconciliation completes. */
export function isRemovalScanIssue(issue: Pick<ScanIssue, 'code'>): boolean {
	return issue.code === 'removal_approval_required' || issue.code === 'removal_confirmation_pending';
}
