import { setMediaIssueIgnored } from './ignored-media-issues.js';
import { and, eq, sql } from 'drizzle-orm';
import type { ScanIssue } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { mediaTailAssessments } from '../db/schema.js';

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
			set: {
				fingerprint: sql`excluded.fingerprint`,
				// Percentage eligibility is recomputed; keep the unchanged physical file's visual cache.
				result: sql`CASE WHEN excluded.result = 'within-duration-tolerance'
					AND ${mediaTailAssessments.fingerprint} = excluded.fingerprint
					THEN ${mediaTailAssessments.result} ELSE excluded.result END`,
				accepted: sql`excluded.accepted`,
			},
		}).run();
	}
}

/** Accept or restore an eligible finding atomically; concurrent scans and stale identities conflict. */
export function setSilentEndingAcceptance(db: MoiraiDatabase, libraryId: string, relativePath: string, fingerprint: string, accepted: boolean): boolean {
	return setMediaIssueIgnored(db, libraryId, relativePath, 'media_audio_video_duration_mismatch', fingerprint, accepted);
}
