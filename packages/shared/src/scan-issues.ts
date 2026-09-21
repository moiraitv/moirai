import type { ScanIssue } from './index.js';

/** Identify scan diagnostics that stop requiring attention once missing-item reconciliation completes. */
export function isRemovalScanIssue(issue: Pick<ScanIssue, 'code'>): boolean {
	return issue.code === 'removal_approval_required' || issue.code === 'removal_confirmation_pending';
}

/** Keep accepted or visually qualifying tail findings out of active warning counts. */
export function isSuppressedScanIssue(issue: ScanIssue): boolean {
	return issue.code === 'media_audio_video_duration_mismatch'
		&& Boolean(issue.tailAssessment?.accepted || issue.tailAssessment?.result === 'black'
			|| issue.tailAssessment?.result === 'mostly-black');
}
