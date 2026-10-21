import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { isIgnorableMediaIssue, isSuppressedScanIssue, libraryCreateSchema, type ScanIssue } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { ignoredMediaIssues, libraries, mediaTailAssessments, scanRuns } from '@server/db/schema.js';
import { Repository } from '@server/repository/index.js';
import { applyMediaIssueIgnores } from '@server/repository/ignored-media-issues.js';
import { persistTailAssessments } from '@server/repository/media-tail-assessments.js';
import { discoverOnDisk } from '@server/scanner/on-disk.js';
import { parseMediaProbeOutput } from '@server/media/media-probe.js';
import * as mediaProbe from '@server/media/media-probe.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

async function fixture(typeKey = 'movies') {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-ignore-'));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	cleanups.push(() => database.close());
	const repository = new Repository(database.db);
	const library = await repository.createLibrary(libraryCreateSchema.parse({
		name: 'Movies', typeKey, sourceType: 'on-disk', sourceConfig: { scanRoot: root },
	}));
	return { root, database, repository, library };
}

const eligible = [
	'media_invalid_output', 'media_missing_duration', 'media_missing_video', 'media_probe_failed',
	'media_timed_out', 'media_audio_video_duration_mismatch', 'media_unreadable', 'media_changed_during_scan',
	'nfo_missing', 'nfo_invalid', 'nfo_too_large', 'tvshow_nfo_invalid', 'metadata_invalid',
	'metadata_truncated', 'multipart_ambiguous', 'multipart_incomplete', 'multipart_duration_invalid',
	'show_external_id_conflict',
];

it('ignores and restores every eligible family without reviving resolved reconciliation counts', async () => {
	const { database, repository, library } = await fixture();
	const run = await repository.beginScan(library.id, 'manual');
	await repository.cancelScan(run);
	const issues: ScanIssue[] = eligible.map(code => ({
		code, path: 'film.mp4', message: 'A diagnostic', severity: 'warning',
		ignoreState: { fingerprint: 'a'.repeat(64), ignored: false },
	}));
	issues.push({ code: 'removal_approval_required', path: null, message: 'Resolved removal', severity: 'warning' });
	database.db.update(scanRuns).set({ issues }).where(eq(scanRuns.id, run.id)).run();
	database.db.update(libraries).set({ warningCount: eligible.length, pendingRemovalCount: 0 }).run();
	for (const code of eligible) {
		expect(repository.setMediaIssueIgnored(library.id, 'film.mp4', code, 'a'.repeat(64), true)).toBe(true);
	}
	expect((await repository.getLibrary(library.id))?.warningCount).toBe(0);
	expect(database.db.select().from(ignoredMediaIssues).all()).toHaveLength(eligible.length);
	expect((await repository.listScans(library.id))[0]?.issues.filter(isSuppressedScanIssue)).toHaveLength(eligible.length);
	for (const code of eligible) {
		expect(repository.setMediaIssueIgnored(library.id, 'film.mp4', code, 'b'.repeat(64), false)).toBe(false);
		expect(repository.setMediaIssueIgnored(library.id, 'film.mp4', code, 'a'.repeat(64), false)).toBe(true);
	}
	expect((await repository.getLibrary(library.id))?.warningCount).toBe(eligible.length);
	expect(database.db.select().from(ignoredMediaIssues).all()).toEqual([]);
});

it.each(['directory_unreadable', 'media_executable_unavailable', 'media_resource_exhausted', 'scan_failed', 'source_unavailable', 'removal_approval_required'])('excludes operational finding %s even with a path and identity', async code => {
	const { database, repository, library } = await fixture();
	const run = await repository.beginScan(library.id, 'manual');
	await repository.cancelScan(run);
	const issue: ScanIssue = { code, path: 'film.mp4', message: 'Failure', severity: 'error', ignoreState: { fingerprint: 'a'.repeat(64), ignored: false } };
	database.db.update(scanRuns).set({ issues: [issue] }).run();
	expect(isIgnorableMediaIssue(issue)).toBe(false);
	expect(repository.setMediaIssueIgnored(library.id, issue.path!, code, issue.ignoreState!.fingerprint, true)).toBe(false);
});

it.each(['source_change_requires_approval', 'source_identity_requires_approval', 'source_candidate_incomplete'])('rejects decisions for candidate source %s', async code => {
	const { database, repository, library } = await fixture();
	const run = await repository.beginScan(library.id, 'manual');
	await repository.cancelScan(run);
	database.db.update(scanRuns).set({ issues: [
		{ code: 'nfo_missing', path: 'film.mp4', message: 'Missing', severity: 'warning', ignoreState: { fingerprint: 'a'.repeat(64), ignored: false } },
		{ code, path: null, message: 'Candidate source', severity: 'error' },
	] }).run();
	expect(repository.setMediaIssueIgnored(library.id, 'film.mp4', 'nfo_missing', 'a'.repeat(64), true)).toBe(false);
});

it('retains decisions through unrelated changes, partial scans and pruned history, then expires changed metadata', async () => {
	const { root, database, repository, library } = await fixture();
	await writeFile(path.join(root, 'Film.mp4'), 'video');
	const probeMedia = async () => parseMediaProbeOutput(JSON.stringify({ streams: [{ codec_type: 'video', duration: 100 }] }), 5);
	async function scan() {
		const run = await repository.beginScan(library.id, 'manual');
		const found = await discoverOnDisk(library, { probeMedia });
		return repository.reconcileScan(run, found.groups, found.items, found.issues, found.traversalComplete, found.sourceIdentity, found.conflicts);
	}
	const first = await scan();
	const issue = first.issues.find(entry => entry.code === 'nfo_missing')!;
	expect(repository.setMediaIssueIgnored(library.id, issue.path!, issue.code, issue.ignoreState!.fingerprint, true)).toBe(true);
	database.db.transaction(tx => applyMediaIssueIgnores(tx, library.id, [], false, false));
	database.db.delete(scanRuns).run();
	await writeFile(path.join(root, 'unrelated.txt'), 'unrelated');
	expect((await scan()).issues.find(entry => entry.code === issue.code)?.ignoreState?.ignored).toBe(true);
	await writeFile(path.join(root, 'Film.nfo'), '<movie><title>Film</title></movie>');
	await scan();
	expect(database.db.select().from(ignoredMediaIssues).all()).toEqual([]);
	await rm(path.join(root, 'Film.nfo'));
	expect((await scan()).issues.find(entry => entry.code === issue.code)?.ignoreState?.ignored).toBe(false);
	expect(repository.setMediaIssueIgnored(library.id, issue.path!, issue.code, issue.ignoreState!.fingerprint, true)).toBe(true);
	await writeFile(path.join(root, 'Film.mp4'), 'changed video');
	expect((await scan()).issues.find(entry => entry.code === issue.code)?.ignoreState?.ignored).toBe(false);
});

it('clears all explicit decisions and legacy acceptance when accepting a replacement source', async () => {
	const { database, library } = await fixture();
	database.db.insert(ignoredMediaIssues).values({ libraryId: library.id, relativePath: 'old.mp4', code: 'nfo_missing', fingerprint: 'a'.repeat(64) }).run();
	database.db.insert(mediaTailAssessments).values({ libraryId: library.id, relativePath: 'old.mp4', fingerprint: 'a'.repeat(64), result: 'uncertain', accepted: true }).run();
	database.db.transaction(tx => applyMediaIssueIgnores(tx, library.id, [], false, true));
	expect(database.db.select().from(ignoredMediaIssues).all()).toEqual([]);
	expect(database.db.select().from(mediaTailAssessments).get()?.accepted).toBe(false);
});

it('retains a valid visual fallback cache while recording percentage suppression in scan history', async () => {
	const { database, library } = await fixture();
	database.db.insert(mediaTailAssessments).values({ libraryId: library.id, relativePath: 'Film.mp4', fingerprint: 'a'.repeat(64), result: 'mostly-black', accepted: false }).run();
	const issue: ScanIssue = { path: 'Film.mp4', code: 'media_audio_video_duration_mismatch', severity: 'warning', message: 'Mismatch', tailAssessment: { fingerprint: 'a'.repeat(64), result: 'within-duration-tolerance', accepted: false } };
	database.db.transaction(tx => persistTailAssessments(tx, library.id, [issue], true, ['Film.mp4']));
	expect(database.db.select().from(mediaTailAssessments).get()?.result).toBe('mostly-black');
	expect(issue.tailAssessment?.result).toBe('within-duration-tolerance');
});

it('applies repeated findings consistently and retains decisions omitted by a failed scan', async () => {
	const { database, library } = await fixture();
	database.db.insert(ignoredMediaIssues).values(eligible.map(code => ({ libraryId: library.id, relativePath: 'Film.mp4', code, fingerprint: 'a'.repeat(64) }))).run();
	const findings: ScanIssue[] = [...eligible, 'metadata_invalid'].map(code => ({ path: 'Film.mp4', code, message: 'Finding', severity: 'warning', ignoreState: { fingerprint: 'a'.repeat(64), ignored: false } }));
	database.db.transaction(tx => applyMediaIssueIgnores(tx, library.id, findings, true, false));
	expect(findings.every(issue => issue.ignoreState?.ignored)).toBe(true);
	database.db.transaction(tx => applyMediaIssueIgnores(tx, library.id, [{ path: null, code: 'media_executable_unavailable', message: 'Unavailable', severity: 'error' }], true, false));
	expect(database.db.select().from(ignoredMediaIssues).all()).toHaveLength(eligible.length);
	for (const issue of findings) {
		issue.ignoreState!.fingerprint = 'b'.repeat(64);
	}
	database.db.transaction(tx => applyMediaIssueIgnores(tx, library.id, findings, false, false));
	expect(findings.every(issue => !issue.ignoreState?.ignored)).toBe(true);
	expect(database.db.select().from(ignoredMediaIssues).all()).toEqual([]);
});

it('restores a manual ignore immediately while allowing the next scan to suppress it automatically', async () => {
	const { database, repository, library } = await fixture();
	const first = await repository.beginScan(library.id, 'manual');
	await repository.cancelScan(first);
	const original: ScanIssue = { path: 'Film.mp4', code: 'media_audio_video_duration_mismatch', message: 'Mismatch', severity: 'warning', ignoreState: { fingerprint: 'a'.repeat(64), ignored: false }, tailAssessment: { fingerprint: 'a'.repeat(64), result: 'uncertain', accepted: false } };
	database.db.update(scanRuns).set({ issues: [original] }).where(eq(scanRuns.id, first.id)).run();
	database.db.update(libraries).set({ warningCount: 1 }).run();
	expect(repository.setMediaIssueIgnored(library.id, original.path!, original.code, original.ignoreState!.fingerprint, true)).toBe(true);
	const acceptedHistory = (await repository.listScans(library.id))[0];
	const next = await repository.beginScan(library.id, 'manual');
	expect(repository.setMediaIssueIgnored(library.id, original.path!, original.code, original.ignoreState!.fingerprint, false)).toBe(false);
	await repository.cancelScan(next);
	original.tailAssessment!.result = 'within-duration-tolerance';
	database.db.transaction(tx => applyMediaIssueIgnores(tx, library.id, [original], true, false));
	database.db.update(scanRuns).set({ issues: [original] }).where(eq(scanRuns.id, next.id)).run();
	expect(original.ignoreState?.ignored).toBe(true);
	expect(repository.setMediaIssueIgnored(library.id, original.path!, original.code, original.ignoreState!.fingerprint, false)).toBe(true);
	expect((await repository.getLibrary(library.id))?.warningCount).toBe(1);
	expect((await repository.listScans(library.id)).find(scan => scan.id === first.id)).toEqual(acceptedHistory);
	original.tailAssessment!.result = 'within-duration-tolerance';
	database.db.transaction(tx => applyMediaIssueIgnores(tx, library.id, [original], true, false));
	expect(original.ignoreState?.ignored).toBe(false);
	expect(isSuppressedScanIssue(original)).toBe(true);
});

it('clears legacy acceptance when a healthy scan resolves a duration finding', async () => {
	const { database, library } = await fixture();
	database.db.insert(ignoredMediaIssues).values({ libraryId: library.id, relativePath: 'Film.mp4', code: 'media_audio_video_duration_mismatch', fingerprint: 'a'.repeat(64) }).run();
	database.db.insert(mediaTailAssessments).values({ libraryId: library.id, relativePath: 'Film.mp4', fingerprint: 'a'.repeat(64), result: 'uncertain', accepted: true }).run();
	database.db.transaction(tx => applyMediaIssueIgnores(tx, library.id, [], true, false));
	expect(database.db.select().from(ignoredMediaIssues).all()).toEqual([]);
	expect(database.db.select().from(mediaTailAssessments).get()?.accepted).toBe(false);
});

it('expires observed recoveries during partial scans without expiring unobserved inputs', async () => {
	const { root, database, library } = await fixture();
	await writeFile(path.join(root, 'Film.mp4'), 'video');
	await writeFile(path.join(root, 'Film.nfo'), '<movie><title>Film</title></movie>');
	const found = await discoverOnDisk(library, { probeMedia: async () => parseMediaProbeOutput(JSON.stringify({ streams: [{ codec_type: 'video', duration: 100 }] }), 5) });
	database.db.insert(ignoredMediaIssues).values([
		{ libraryId: library.id, relativePath: 'Film.mp4', code: 'media_unreadable', fingerprint: 'a'.repeat(64) },
		{ libraryId: library.id, relativePath: 'Film.mp4', code: 'nfo_missing', fingerprint: 'b'.repeat(64) },
		{ libraryId: library.id, relativePath: 'Unobserved.mp4', code: 'media_unreadable', fingerprint: 'c'.repeat(64) },
	]).run();
	database.db.transaction(tx => applyMediaIssueIgnores(tx, library.id, found.issues, false, false, found.items));
	expect(database.db.select().from(ignoredMediaIssues).all()).toEqual([
		{ libraryId: library.id, relativePath: 'Unobserved.mp4', code: 'media_unreadable', fingerprint: 'c'.repeat(64) },
	]);
});

it('does not expire a shared-NFO ignore when media using its own NFO changes', async () => {
	const { root, repository, library } = await fixture();
	await writeFile(path.join(root, 'A.mp4'), 'video a');
	await writeFile(path.join(root, 'B.mp4'), 'video b');
	await writeFile(path.join(root, 'B.nfo'), '<movie><title>B</title></movie>');
	await writeFile(path.join(root, 'movie.nfo'), '<broken/>');
	async function scan() {
		const run = await repository.beginScan(library.id, 'manual');
		const found = await discoverOnDisk(library, { probeMedia: async () => parseMediaProbeOutput(JSON.stringify({ streams: [{ codec_type: 'video', duration: 100 }] }), 5) });
		expect(found.items.find(item => item.relativePath === 'B.mp4')?.nfoRelativePath).toBe('B.nfo');
		return repository.reconcileScan(run, found.groups, found.items, found.issues, found.traversalComplete, found.sourceIdentity, found.conflicts);
	}
	const issue = (await scan()).issues.find(entry => entry.path === 'movie.nfo')!;
	expect(repository.setMediaIssueIgnored(library.id, issue.path!, issue.code, issue.ignoreState!.fingerprint, true)).toBe(true);
	await writeFile(path.join(root, 'B.mp4'), 'replacement b with its own NFO');
	const unchanged = (await scan()).issues.find(entry => entry.path === 'movie.nfo')!;
	expect(unchanged.ignoreState).toEqual({ ...issue.ignoreState, ignored: true });
	await writeFile(path.join(root, 'A.mp4'), 'replacement a consuming the shared NFO');
	const changed = (await scan()).issues.find(entry => entry.path === 'movie.nfo')!;
	expect(changed.ignoreState?.fingerprint).not.toBe(issue.ignoreState?.fingerprint);
	expect(changed.ignoreState?.ignored).toBe(false);
});

it.each([['movies', 'metadata_invalid'], ['shows', 'metadata_invalid'], ['movies', 'nfo_invalid'], ['movies', 'nfo_missing']])('expires an ignore when %s %s inputs changed after the recorded observation', async (typeKey, code) => {
	const { root, repository, library } = await fixture(typeKey);
	if (typeKey === 'shows') {
		await mkdir(path.join(root, 'Show'));
	}
	const nfoPath = path.join(root, typeKey === 'shows' ? 'Show/tvshow.nfo' : 'Film.nfo');
	await writeFile(path.join(root, typeKey === 'shows' ? 'Show/S01E01.mp4' : 'Film.mp4'), 'video');
	if (code !== 'nfo_missing') {
		await writeFile(nfoPath, code === 'metadata_invalid'
			? '<movie><title>Old</title><runtime>-1</runtime></movie>' : '<broken/>');
	}
	const replacement = code === 'metadata_invalid' ? '<movie><title>New</title><year>-5</year></movie>' : '<changed/>';
	async function scan(changeAfterReading: boolean) {
		const run = await repository.beginScan(library.id, 'manual');
		const found = await discoverOnDisk(library, {
			probeMedia: async () => parseMediaProbeOutput(JSON.stringify({ streams: [{ codec_type: 'video', duration: 100 }] }), 5),
			onProgress(progress) {
				if (changeAfterReading && progress.phase === 'finalizing') {
					writeFileSync(nfoPath, replacement);
				}
			},
		});
		return repository.reconcileScan(run, found.groups, found.items, found.issues, found.traversalComplete, found.sourceIdentity, found.conflicts);
	}
	const baseline = (await scan(false)).issues.find(issue => issue.code === code)!;
	const initial = (await scan(true)).issues.find(issue => issue.code === code)!;
	expect(initial.ignoreState?.fingerprint).toBe(baseline.ignoreState?.fingerprint);
	expect(repository.setMediaIssueIgnored(library.id, initial.path!, initial.code, initial.ignoreState!.fingerprint, true)).toBe(true);
	const next = await scan(false);
	if (code === 'nfo_missing') {
		expect(next.issues.some(issue => issue.code === 'nfo_missing')).toBe(false);
		expect(next.issues.find(issue => issue.code === 'nfo_invalid')?.ignoreState?.ignored).toBe(false);
	}
	else {
		const changed = next.issues.find(issue => issue.code === code)!;
		expect(changed.ignoreState?.fingerprint).not.toBe(initial.ignoreState?.fingerprint);
		expect(changed.ignoreState?.ignored).toBe(false);
	}
});

it.each(['missing metadata', 'invalid metadata', 'multipart'])('preserves existing ignores across a probe upgrade with %s', async scenario => {
	const multipart = scenario === 'multipart';
	const { root, database, repository, library } = await fixture();
	const paths = multipart ? ['Film-part1.mp4', 'Film-part3.mp4'] : ['Film.mp4'];
	for (const file of paths) {
		await writeFile(path.join(root, file), 'video');
		await utimes(path.join(root, file), 1_000, 1_000);
	}
	if (scenario === 'invalid metadata') {
		await writeFile(path.join(root, 'Film.nfo'), '<movie><title>Film</title><runtime>-1</runtime></movie>');
	}
	const probeMedia = vi.fn(async () => parseMediaProbeOutput(JSON.stringify({ streams: [
		{ index: 0, codec_type: 'video', start_time: '0', duration: '100' },
		{ index: 1, codec_type: 'audio', start_time: '0', duration: '60' },
	] }), 5));
	const inspectTail = vi.fn(async (): Promise<'not-black'> => 'not-black');
	async function scan() {
		const run = await repository.beginScan(library.id, 'manual');
		const found = await discoverOnDisk(library, {
			probeMedia, inspectTail, tailAssessments: await repository.listTailAssessments(library.id),
			probeCache: new Map((await repository.listMediaProbeCache(library.id)).map(entry => [entry.relativePath, entry])),
		});
		return repository.reconcileScan(run, found.groups, found.items, found.issues, found.traversalComplete, found.sourceIdentity, found.conflicts);
	}
	const initial = await scan();
	expect(initial.issues.map(issue => issue.code)).toContain(scenario === 'invalid metadata' ? 'metadata_invalid' : 'nfo_missing');
	if (multipart) {
		expect(initial.issues.map(issue => issue.code)).toContain('multipart_incomplete');
	}
	const info = await stat(path.join(root, paths[0]!), { bigint: true });
	const legacyFingerprint = createHash('sha256').update(`11:${info.size}:${info.mtimeMs}`).digest('hex');
	const duration = initial.issues.find(issue => issue.code === 'media_audio_video_duration_mismatch')!;
	expect(duration.ignoreState?.fingerprint).toBe(legacyFingerprint);
	expect(duration.tailAssessment?.fingerprint).toBe(legacyFingerprint);
	for (const issue of initial.issues) {
		expect(repository.setMediaIssueIgnored(library.id, issue.path!, issue.code, issue.ignoreState!.fingerprint, true)).toBe(true);
	}
	const decisions = database.db.select().from(ignoredMediaIssues).all();
	const history = (await repository.listScans(library.id))[0];
	await scan();
	const inspectedBeforeUpgrade = inspectTail.mock.calls.length;
	probeMedia.mockClear();

	// Change the actual cache-key function used by discovery to simulate a future probe release.
	vi.spyOn(mediaProbe, 'mediaProbeFingerprint').mockImplementation(info => createHash('sha256')
		.update(`${mediaProbe.MEDIA_PROBE_VERSION + 1}:${info.size}:${info.mtimeMs}`).digest('hex'));
	const upgraded = await scan();
	expect(probeMedia).toHaveBeenCalledTimes(paths.length);
	expect(inspectTail).toHaveBeenCalledTimes(inspectedBeforeUpgrade + paths.length);
	expect(upgraded.issues).toHaveLength(initial.issues.length);
	expect(upgraded.issues.every(issue => issue.ignoreState?.ignored)).toBe(true);
	expect((await repository.getLibrary(library.id))?.warningCount).toBe(0);
	expect(database.db.select().from(ignoredMediaIssues).all()).toEqual(decisions);
	expect((await repository.listScans(library.id)).find(scan => scan.id === initial.id)).toEqual(history);
	const cache = await repository.listMediaProbeCache(library.id);
	expect(cache.find(entry => entry.relativePath === paths[0])?.probeFingerprint).toBe(mediaProbe.mediaProbeFingerprint(info));

	// Both legacy acceptance and general ignore actions retain their existing fingerprints.
	expect(repository.setSilentEndingAcceptance(library.id, duration.path!, legacyFingerprint, false)).toBe(true);
	expect((await repository.getLibrary(library.id))?.warningCount).toBe(1);
	expect(repository.setSilentEndingAcceptance(library.id, duration.path!, legacyFingerprint, true)).toBe(true);
	await utimes(path.join(root, paths[0]!), 2_000, 2_000);
	const changed = await scan();
	expect(changed.issues.find(issue => issue.path === duration.path && issue.code === duration.code)?.ignoreState?.ignored).toBe(false);
	expect((await repository.getLibrary(library.id))!.warningCount).toBeGreaterThan(0);
});

it.each(['interval', 'stream'])('rechecks visual suppression when a probe upgrade changes the %s', async change => {
	const { root, repository, library } = await fixture();
	await writeFile(path.join(root, 'Film.mp4'), 'video');
	await writeFile(path.join(root, 'Film.nfo'), '<movie><title>Film</title></movie>');
	const initialProbe = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ index: 0, codec_type: 'video', start_time: '0', duration: '140' },
		{ index: 1, codec_type: 'audio', start_time: '0', duration: '100' },
	] }), 5);
	const refreshedProbe = parseMediaProbeOutput(JSON.stringify({ streams: [
		{ index: change === 'stream' ? 2 : 0, codec_type: 'video', start_time: '0', duration: '140' },
		{ index: 1, codec_type: 'audio', start_time: '0', duration: change === 'interval' ? '60' : '100' },
	] }), 5);
	const probeMedia = vi.fn().mockResolvedValue(initialProbe);
	const inspectTail = vi.fn().mockResolvedValue('mostly-black');
	async function scan() {
		const run = await repository.beginScan(library.id, 'manual');
		const found = await discoverOnDisk(library, {
			probeMedia, inspectTail, tailAssessments: await repository.listTailAssessments(library.id),
			probeCache: new Map((await repository.listMediaProbeCache(library.id)).map(entry => [entry.relativePath, entry])),
		});
		return repository.reconcileScan(run, found.groups, found.items, found.issues, found.traversalComplete, found.sourceIdentity, found.conflicts);
	}
	const initial = await scan();
	await scan();
	expect(probeMedia).toHaveBeenCalledOnce();
	expect(inspectTail).toHaveBeenCalledOnce();
	expect((await repository.getLibrary(library.id))?.warningCount).toBe(0);

	vi.spyOn(mediaProbe, 'mediaProbeFingerprint').mockImplementation(info => createHash('sha256')
		.update(`${mediaProbe.MEDIA_PROBE_VERSION + 1}:${info.size}:${info.mtimeMs}`).digest('hex'));
	probeMedia.mockResolvedValue(refreshedProbe);
	inspectTail.mockResolvedValue('not-black');
	const upgraded = await scan();
	expect(probeMedia).toHaveBeenCalledTimes(2);
	expect(inspectTail).toHaveBeenCalledTimes(2);
	expect(inspectTail.mock.calls[1]?.[2]).toMatchObject({
		streamIndex: change === 'stream' ? 2 : 0,
		startSeconds: change === 'interval' ? 60 : 100,
		durationSeconds: change === 'interval' ? 80 : 40,
	});
	const issue = upgraded.issues.find(issue => issue.code === 'media_audio_video_duration_mismatch')!;
	expect(issue.tailAssessment?.result).toBe('not-black');
	expect(issue.ignoreState).toEqual(initial.issues.find(entry => entry.code === issue.code)?.ignoreState);
	expect((await repository.getLibrary(library.id))?.warningCount).toBe(1);
	await scan();
	expect(inspectTail).toHaveBeenCalledTimes(2);
	expect((await repository.listTailAssessments(library.id)).get('Film.mp4')?.result).toBe('not-black');
});
