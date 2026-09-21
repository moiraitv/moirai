import { and, desc, eq, sql } from 'drizzle-orm';
import { isSuppressedScanIssue, type ScanIssue } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { libraries, mediaTailAssessments, scanRuns } from '../db/schema.js';

/** One SQLite transaction owns assessment persistence together with its completed scan. */
type ScanTransaction = Parameters<Parameters<MoiraiDatabase['transaction']>[0]>[0];

/** Read physical-file outcomes once per background scan, including multipart members. */
export async function listTailAssessments(db: MoiraiDatabase, libraryId: string) {
	const rows = await db.select().from(mediaTailAssessments).where(eq(mediaTailAssessments.libraryId, libraryId));
	return new Map(rows.map(row => [row.relativePath, {
		fingerprint: row.fingerprint, result: row.result, accepted: row.accepted,
	}]));
}

/** Batch current outcomes and remove absent paths, retaining decisions through transient file errors. */
export function persistTailAssessments(tx: ScanTransaction, libraryId: string, issues: ScanIssue[], complete: boolean, observedPaths: string[]): void {
	if (complete) {
		tx.delete(mediaTailAssessments).where(and(
			eq(mediaTailAssessments.libraryId, libraryId),
			sql`${mediaTailAssessments.relativePath} NOT IN (SELECT value FROM json_each(${JSON.stringify(observedPaths)}))`,
		)).run();
	}
	const rows = issues.flatMap(issue => issue.path && issue.tailAssessment
		? [{ libraryId, relativePath: issue.path, ...issue.tailAssessment }] : []);
	for (let offset = 0; offset < rows.length; offset += 100) {
		tx.insert(mediaTailAssessments).values(rows.slice(offset, offset + 100)).onConflictDoUpdate({
			target: [mediaTailAssessments.libraryId, mediaTailAssessments.relativePath],
			set: { fingerprint: sql`excluded.fingerprint`, result: sql`excluded.result`, accepted: sql`excluded.accepted` },
		}).run();
	}
}

/** Accept or restore an eligible finding atomically; concurrent scans and stale identities conflict. */
export function setSilentEndingAcceptance(db: MoiraiDatabase, libraryId: string, relativePath: string, fingerprint: string, accepted: boolean): boolean {
	return db.transaction(tx => {
		const running = tx.select({ id: scanRuns.id }).from(scanRuns)
			.where(and(eq(scanRuns.libraryId, libraryId), eq(scanRuns.status, 'running'))).get();
		const latest = tx.select().from(scanRuns).where(eq(scanRuns.libraryId, libraryId))
			.orderBy(desc(scanRuns.startedAt), sql`rowid DESC`).get();
		if (running || !latest) {
			return false;
		}
		const issue = latest.issues.find(entry => entry.path === relativePath
			&& entry.code === 'media_audio_video_duration_mismatch'
			&& entry.tailAssessment?.fingerprint === fingerprint);
		if (!issue?.tailAssessment || ['black', 'mostly-black'].includes(issue.tailAssessment.result)) {
			return false;
		}
		const updated = tx.update(mediaTailAssessments).set({ accepted })
			.where(and(
				eq(mediaTailAssessments.libraryId, libraryId),
				eq(mediaTailAssessments.relativePath, relativePath),
				eq(mediaTailAssessments.fingerprint, fingerprint),
			))
			.run();
		if (!updated.changes) {
			return false;
		}
		const wasSuppressed = isSuppressedScanIssue(issue);
		issue.tailAssessment.accepted = accepted;
		tx.update(scanRuns).set({ issues: latest.issues }).where(eq(scanRuns.id, latest.id)).run();
		const delta = Number(wasSuppressed) - Number(isSuppressedScanIssue(issue));
		tx.update(libraries).set({ warningCount: sql`max(0, ${libraries.warningCount} + ${delta})` })
			.where(eq(libraries.id, libraryId)).run();
		return true;
	});
}
