import { and, desc, eq, sql } from 'drizzle-orm';
import { isAutomaticallySuppressedScanIssue, isIgnorableMediaIssue, isSuppressedScanIssue, type ScanIssue } from '@moirai/shared';
import type { DiscoveredItem } from './contracts.js';
import type { MoiraiDatabase } from '../db/index.js';
import { ignoredMediaIssues, libraries, mediaTailAssessments, scanRuns } from '../db/schema.js';

/** Decisions and completed scan health share one SQLite transaction. */
type ScanTransaction = Parameters<Parameters<MoiraiDatabase['transaction']>[0]>[0];

/** Apply decisions in one read and expire only resolved or changed observations from this scan. */
export function applyMediaIssueIgnores(tx: ScanTransaction, libraryId: string, issues: ScanIssue[], complete: boolean, replacingSource: boolean, items: DiscoveredItem[] = []): void {
	for (const issue of issues) {
		if (issue.ignoreState) {
			issue.ignoreState.ignored = false;
		}
	}
	if (replacingSource) {
		tx.update(mediaTailAssessments).set({ accepted: false }).where(eq(mediaTailAssessments.libraryId, libraryId)).run();
	}
	const decisions = tx.select().from(ignoredMediaIssues).where(eq(ignoredMediaIssues.libraryId, libraryId)).all();
	const current = new Map<string, ScanIssue[]>();
	for (const issue of issues.filter(isIgnorableMediaIssue)) {
		const key = JSON.stringify([issue.path, issue.code]);
		current.set(key, [...(current.get(key) ?? []), issue]);
	}
	const readablePaths = new Set(items.flatMap(item => [item.relativePath, ...item.parts.map(part => part.relativePath)]));
	const probedPaths = new Set(items.flatMap(item => [
		...(item.probeStatus === 'complete' ? [item.relativePath] : []),
		...item.parts.filter(part => part.durationSeconds !== null).map(part => part.relativePath),
	]));
	const metadataPaths = new Set(items.filter(item => item.metadataStatus === 'complete')
		.flatMap(item => [item.relativePath, ...(item.nfoRelativePath ? [item.nfoRelativePath] : [])]));
	const healthyCompletion = complete && !issues.some(issue => issue.severity === 'error');
	const expired: string[] = [];
	for (const decision of decisions) {
		const key = JSON.stringify([decision.relativePath, decision.code]);
		const matching = current.get(key) ?? [];
		const resolvedObservation = ['media_unreadable', 'media_changed_during_scan'].includes(decision.code)
			? readablePaths.has(decision.relativePath)
			: decision.code.startsWith('media_')
				? probedPaths.has(decision.relativePath)
				: ['nfo_missing', 'nfo_invalid', 'nfo_too_large', 'metadata_invalid', 'metadata_truncated'].includes(decision.code)
					&& metadataPaths.has(decision.relativePath);
		if (replacingSource || matching.some(issue => issue.ignoreState && issue.ignoreState.fingerprint !== decision.fingerprint)
			|| ((healthyCompletion || resolvedObservation) && !matching.length)) {
			expired.push(key);
		}
		else {
			for (const issue of matching) {
				if (issue.ignoreState) {
					issue.ignoreState.ignored = true;
				}
			}
		}
	}
	if (expired.length) {
		tx.delete(ignoredMediaIssues).where(and(
			eq(ignoredMediaIssues.libraryId, libraryId),
			sql`json_array(${ignoredMediaIssues.relativePath}, ${ignoredMediaIssues.code}) IN (SELECT value FROM json_each(${JSON.stringify(expired)}))`,
		)).run();
		// Clear legacy acceptance even when a resolved duration finding has no new assessment row.
		tx.update(mediaTailAssessments).set({ accepted: false }).where(and(
			eq(mediaTailAssessments.libraryId, libraryId),
			eq(mediaTailAssessments.accepted, true),
			sql`NOT EXISTS (SELECT 1 FROM ${ignoredMediaIssues}
				WHERE ${ignoredMediaIssues.libraryId} = ${mediaTailAssessments.libraryId}
				AND ${ignoredMediaIssues.relativePath} = ${mediaTailAssessments.relativePath}
				AND ${ignoredMediaIssues.code} = 'media_audio_video_duration_mismatch'
				AND ${ignoredMediaIssues.fingerprint} = ${mediaTailAssessments.fingerprint})`,
		)).run();
	}
	for (const issue of issues) {
		if (issue.tailAssessment) {
			issue.tailAssessment.accepted = Boolean(issue.ignoreState?.ignored);
		}
	}
}

/** Validate and persist a current decision without changing catalog or reconciliation state. */
export function setMediaIssueIgnored(db: MoiraiDatabase, libraryId: string, relativePath: string, code: string, fingerprint: string, ignored: boolean): boolean {
	return db.transaction(tx => {
		const running = tx.select({ id: scanRuns.id }).from(scanRuns)
			.where(and(eq(scanRuns.libraryId, libraryId), eq(scanRuns.status, 'running'))).get();
		const latest = tx.select().from(scanRuns).where(eq(scanRuns.libraryId, libraryId))
			.orderBy(desc(scanRuns.startedAt), sql`rowid DESC`).get();
		if (running || !latest || latest.issues.some(issue => [
			'source_change_requires_approval', 'source_identity_requires_approval', 'source_candidate_incomplete',
		].includes(issue.code))) {
			return false;
		}
		const matching = latest.issues.filter(entry => entry.path === relativePath && entry.code === code);
		if (!matching.length || matching.some(issue => !isIgnorableMediaIssue(issue)
			|| (issue.ignoreState?.fingerprint ?? issue.tailAssessment?.fingerprint) !== fingerprint
			|| (isAutomaticallySuppressedScanIssue(issue) && !issue.ignoreState?.ignored && !issue.tailAssessment?.accepted))) {
			return false;
		}

		const key = and(eq(ignoredMediaIssues.libraryId, libraryId), eq(ignoredMediaIssues.relativePath, relativePath), eq(ignoredMediaIssues.code, code));
		if (ignored) {
			tx.insert(ignoredMediaIssues).values({ libraryId, relativePath, code, fingerprint }).onConflictDoUpdate({
				target: [ignoredMediaIssues.libraryId, ignoredMediaIssues.relativePath, ignoredMediaIssues.code], set: { fingerprint },
			}).run();
		}
		else {
			tx.delete(ignoredMediaIssues).where(key).run();
		}
		let delta = 0;
		for (const issue of matching) {
			const wasSuppressed = isSuppressedScanIssue(issue);
			issue.ignoreState = { fingerprint, ignored };
			if (issue.tailAssessment) {
				issue.tailAssessment.accepted = ignored;
				// Restoring is immediate; a subsequent scan can automatically suppress it again.
				if (!ignored && isAutomaticallySuppressedScanIssue(issue)) {
					issue.tailAssessment.result = 'uncertain';
				}
			}
			delta += Number(wasSuppressed) - Number(isSuppressedScanIssue(issue));
		}
		if (code === 'media_audio_video_duration_mismatch') {
			tx.update(mediaTailAssessments).set({ accepted: ignored }).where(and(
				eq(mediaTailAssessments.libraryId, libraryId),
				eq(mediaTailAssessments.relativePath, relativePath),
				eq(mediaTailAssessments.fingerprint, fingerprint),
			)).run();
		}
		tx.update(scanRuns).set({ issues: latest.issues }).where(eq(scanRuns.id, latest.id)).run();
		tx.update(libraries).set({ warningCount: sql`max(0, ${libraries.warningCount} + ${delta})` })
			.where(eq(libraries.id, libraryId)).run();
		return true;
	});
}
