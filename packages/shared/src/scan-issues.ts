import type { ScanIssue } from './index.js';

/** Identify scan diagnostics that stop requiring attention once missing-item reconciliation completes. */
export function isRemovalScanIssue(issue: Pick<ScanIssue, 'code'>): boolean {
	return issue.code === 'removal_approval_required' || issue.code === 'removal_confirmation_pending';
}

/** File-specific diagnostics that support reversible, identity-bound ignoring. */
const IGNORABLE_MEDIA_CODES = new Set([
	'media_invalid_output', 'media_missing_duration', 'media_missing_video', 'media_probe_failed',
	'media_timed_out', 'media_audio_video_duration_mismatch', 'media_unreadable', 'media_changed_during_scan',
	'nfo_missing', 'nfo_invalid', 'nfo_too_large', 'tvshow_nfo_invalid', 'metadata_invalid',
	'metadata_truncated', 'multipart_ambiguous', 'multipart_incomplete', 'multipart_duration_invalid',
	'show_external_id_conflict',
]);

/** Exclude operational and source-reconciliation findings even when they carry a path. */
export function isIgnorableMediaIssue(issue: Pick<ScanIssue, 'code' | 'path'>): boolean {
	return Boolean(issue.path) && IGNORABLE_MEDIA_CODES.has(issue.code);
}

/** Identify automatic duration suppression without granting a manual override. */
export function isAutomaticallySuppressedScanIssue(issue: ScanIssue): boolean {
	return issue.code === 'media_audio_video_duration_mismatch'
		&& ['black', 'mostly-black', 'within-duration-tolerance'].includes(issue.tailAssessment?.result ?? '');
}

/** Keep manual ignores and automatically qualifying duration findings out of attention counts. */
export function isSuppressedScanIssue(issue: ScanIssue): boolean {
	return Boolean(mediaIssueIgnoreState(issue)?.ignored) || isAutomaticallySuppressedScanIssue(issue);
}

/** Read current decisions while keeping pre-migration silent-ending findings actionable. */
export function mediaIssueIgnoreState(issue: ScanIssue): ScanIssue['ignoreState'] {
	if (!isIgnorableMediaIssue(issue)) {
		return undefined;
	}
	return issue.ignoreState ?? (issue.code === 'media_audio_video_duration_mismatch' && issue.tailAssessment
		? { fingerprint: issue.tailAssessment.fingerprint, ignored: issue.tailAssessment.accepted } : undefined);
}
