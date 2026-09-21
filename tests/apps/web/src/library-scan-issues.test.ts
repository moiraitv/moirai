import { describe, expect, it } from 'vitest';
import { libraryScanAttention } from '@web/library-scan-issues';
import type { ScanIssue } from '@moirai/shared';

const removal: ScanIssue = { code: 'removal_approval_required', path: null, message: '13 missing items require explicit reconciliation.', severity: 'error' };
const unrelated: ScanIssue = { code: 'scan_failed', path: null, message: 'Source unavailable.', severity: 'error' };

describe('current library scan attention', () => {
	it.each(['black', 'mostly-black'] as const)('excludes %s findings while preserving history', result => {
		const suppressed: ScanIssue = {
			code: 'media_audio_video_duration_mismatch', path: 'film.mp4', message: 'Silent tail', severity: 'warning',
			tailAssessment: { fingerprint: 'file', result, accepted: false },
		};
		const scans = [{ status: 'complete' as const, issues: [suppressed, unrelated] }];
		expect(libraryScanAttention({ warningCount: 1, pendingRemovalCount: 0 }, scans))
			.toEqual({ count: 1, issues: [unrelated] });
		expect(scans[0]!.issues).toEqual([suppressed, unrelated]);
	});

	it('hides an already-stale removal alert after reconciliation without mutating scan history', () => {
		const scans = [{ status: 'partial' as const, issues: [removal] }];
		expect(libraryScanAttention({ warningCount: 1, pendingRemovalCount: 0 }, scans)).toEqual({ count: 0, issues: [] });
		expect(scans[0]!.issues).toEqual([removal]);
	});

	it('keeps pending removal diagnostics visible', () => {
		expect(libraryScanAttention({ warningCount: 1, pendingRemovalCount: 13 }, [{ status: 'partial', issues: [removal] }]))
			.toEqual({ count: 1, issues: [removal] });
	});

	it('preserves unrelated warnings after the server corrects the warning count', () => {
		expect(libraryScanAttention({ warningCount: 1, pendingRemovalCount: 0 }, [{ status: 'partial', issues: [removal, unrelated] }]))
			.toEqual({ count: 1, issues: [unrelated] });
	});

	it('filters resolved ordinary removal confirmations too', () => {
		expect(libraryScanAttention({ warningCount: 1, pendingRemovalCount: 0 }, [{ status: 'partial', issues: [{ ...removal, code: 'removal_confirmation_pending' }] }]))
			.toEqual({ count: 0, issues: [] });
	});

	it('uses the latest completed scan while a new scan runs', () => {
		expect(libraryScanAttention({ warningCount: 1, pendingRemovalCount: 0 }, [
			{ status: 'running', issues: [] }, { status: 'failed', issues: [unrelated] }, { status: 'partial', issues: [removal] },
		])).toEqual({ count: 1, issues: [unrelated] });
	});

	it('retains the warning count when detailed scan history has expired', () => {
		expect(libraryScanAttention({ warningCount: 2, pendingRemovalCount: 0 }, [])).toEqual({ count: 2, issues: [] });
	});
});
