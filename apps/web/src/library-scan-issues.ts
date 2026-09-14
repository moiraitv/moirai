import { isRemovalScanIssue, type Library, type ScanRun } from '@moirai/shared';

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

	const issues = latest.issues.filter(issue => library.pendingRemovalCount > 0 || !isRemovalScanIssue(issue));
	return { count: Math.min(library.warningCount, issues.length), issues };
}
