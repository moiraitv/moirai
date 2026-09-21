import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { registerSilentEndingRoutes } from '@server/routes/silent-endings.js';
import { responseSerializerCompiler } from '@server/routes/contracts.js';
import { publicError } from '@server/routes/public-errors.js';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { libraryCreateSchema, isSuppressedScanIssue } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { mediaTailAssessments, scanRuns } from '@server/db/schema.js';
import { persistTailAssessments } from '@server/repository/media-tail-assessments.js';
import { Repository } from '@server/repository/index.js';
import { discoverOnDisk } from '@server/scanner/on-disk.js';
import { parseMediaProbeOutput } from '@server/media/media-probe.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.reverse().splice(0)) {
		await cleanup(); 
	} 
});

it('persists acceptance across scans and history pruning, then invalidates it when the file changes', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-tail-cache-'));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	cleanups.push(() => {
		database.close(); 
	});
	const repository = new Repository(database.db);
	const library = await repository.createLibrary(libraryCreateSchema.parse({
		name: 'Movies', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: root },
	}));
	await writeFile(path.join(root, 'Film.mp4'), 'video');
	await writeFile(path.join(root, 'Film.nfo'), '<movie><title>Film</title></movie>');
	const inspectTail = vi.fn(async (): Promise<'black' | 'mostly-black' | 'not-black' | 'uncertain'> => 'not-black');
	const probeMedia = async () => parseMediaProbeOutput(JSON.stringify({ streams: [
		{ index: 0, codec_type: 'video', start_time: '0', duration: '100' },
		{ index: 1, codec_type: 'audio', start_time: '0', duration: '60' },
	] }), 5);
	async function scan() {
		const run = await repository.beginScan(library.id, 'manual');
		const found = await discoverOnDisk(library, {
			probeMedia, inspectTail, tailAssessments: await repository.listTailAssessments(library.id),
			probeCache: new Map((await repository.listMediaProbeCache(library.id)).map(entry => [entry.relativePath, entry])),
		});
		return repository.reconcileScan(run, found.groups, found.items, found.issues, true, found.sourceIdentity, found.conflicts);
	}
	const first = await scan();
	const issue = first.issues.find(entry => entry.tailAssessment)!;
	expect(issue.tailAssessment?.result).toBe('not-black');
	expect(inspectTail).toHaveBeenCalledOnce();
	expect(repository.setSilentEndingAcceptance(library.id, issue.path!, 'stale', true)).toBe(false);
	const app = Fastify();
	cleanups.push(() => app.close());
	await app.register(sensible);
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		void reply.status(mapped.statusCode).send(mapped.body);
	});
	const publish = vi.fn();
	registerSilentEndingRoutes(app, repository, { publish });
	const payload = { path: issue.path!, fingerprint: issue.tailAssessment!.fingerprint, accepted: true };
	const url = `/api/v1/libraries/${library.id}/silent-ending`;
	expect((await app.inject({ method: 'PUT', url, payload: { ...payload, fingerprint: 'invalid' } })).statusCode).toBe(400);
	expect((await app.inject({ method: 'PUT', url, payload: { ...payload, fingerprint: '0'.repeat(64) } })).statusCode).toBe(409);
	const response = await app.inject({ method: 'PUT', url, payload });
	expect(response.statusCode).toBe(200);
	expect(response.json()[0].issues[0].tailAssessment.accepted).toBe(true);
	expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'library.changed' }));

	expect((await repository.getLibrary(library.id))!.warningCount).toBe(0);
	expect((await repository.listScans(library.id))[0]!.issues.some(isSuppressedScanIssue)).toBe(true);

	// Transient source errors must not erase an accepted decision for an observed file.
	database.db.transaction(tx => persistTailAssessments(tx, library.id, [], true, ['Film.mp4']));
	expect((await repository.listTailAssessments(library.id)).get('Film.mp4')!.accepted).toBe(true);

	// Acceptance is independent of retained scan history and applies without decoding again.
	database.db.delete(scanRuns).run();
	expect((await scan()).issues.some(isSuppressedScanIssue)).toBe(true);
	expect(inspectTail).toHaveBeenCalledOnce();
	expect(repository.setSilentEndingAcceptance(library.id, issue.path!, issue.tailAssessment!.fingerprint, false)).toBe(true);
	expect((await repository.getLibrary(library.id))!.warningCount).toBe(1);
	expect(repository.setSilentEndingAcceptance(library.id, issue.path!, issue.tailAssessment!.fingerprint, true)).toBe(true);
	const running = await repository.beginScan(library.id, 'manual');
	expect(repository.setSilentEndingAcceptance(library.id, issue.path!, issue.tailAssessment!.fingerprint, true)).toBe(false);
	await repository.cancelScan(running);

	await writeFile(path.join(root, 'Film.mp4'), 'changed video');
	const changed = await scan();
	expect(changed.issues.some(isSuppressedScanIssue)).toBe(false);
	expect(inspectTail).toHaveBeenCalledTimes(2);
	expect(changed.issues.find(entry => entry.tailAssessment)!.tailAssessment!.fingerprint)
		.not.toBe(issue.tailAssessment!.fingerprint);

	inspectTail.mockResolvedValue('mostly-black');
	await writeFile(path.join(root, 'Film.mp4'), 'black ending replacement');
	expect((await scan()).issues.some(isSuppressedScanIssue)).toBe(true);
	expect((await repository.getLibrary(library.id))!.warningCount).toBe(0);
	expect((await repository.listTailAssessments(library.id)).get('Film.mp4')!.result).toBe('mostly-black');
	const suppressed = (await repository.listScans(library.id))[0]!.issues.find(entry => entry.tailAssessment)!;
	expect(repository.setSilentEndingAcceptance(library.id, suppressed.path!, suppressed.tailAssessment!.fingerprint, true)).toBe(false);
	await rm(path.join(root, 'Film.mp4'));
	await scan();
	expect(await repository.listTailAssessments(library.id)).toEqual(new Map());
});

it('reassesses prior automatic failures while preserving acceptance, black results, and scan history', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-tail-upgrade-'));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const migrations = path.join(root, 'migrations');
	await cp(path.resolve('drizzle'), migrations, { recursive: true });
	const journalPath = path.join(migrations, 'meta', '_journal.json');
	const journal = JSON.parse(await readFile(journalPath, 'utf8'));
	journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 35);
	await writeFile(journalPath, JSON.stringify(journal));
	const databasePath = path.join(root, 'prior.sqlite');
	const prior = createDatabase(databasePath, migrations);
	const repository = new Repository(prior.db);
	const library = await repository.createLibrary(libraryCreateSchema.parse({
		name: 'Preserved', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: root },
	}));
	const run = await repository.beginScan(library.id, 'manual');
	await repository.cancelScan(run);
	const assessments = [
		{ relativePath: 'black.mp4', result: 'black' as const, accepted: false },
		{ relativePath: 'credits.mp4', result: 'not-black' as const, accepted: false },
		{ relativePath: 'uncertain.mp4', result: 'uncertain' as const, accepted: false },
		{ relativePath: 'accepted-credits.mp4', result: 'not-black' as const, accepted: true },
		{ relativePath: 'accepted-uncertain.mp4', result: 'uncertain' as const, accepted: true },
	];
	prior.db.insert(mediaTailAssessments).values(assessments.map(assessment => ({
		...assessment, libraryId: library.id, fingerprint: 'a'.repeat(64),
	}))).run();
	prior.db.update(scanRuns).set({ issues: [{
		path: 'credits.mp4', code: 'media_audio_video_duration_mismatch', severity: 'warning', message: 'Historical finding',
		tailAssessment: { fingerprint: 'a'.repeat(64), result: 'not-black', accepted: false },
	}] }).run();
	const history = await repository.listScans(library.id);
	const priorLibrary = await repository.getLibrary(library.id);
	prior.close();
	const upgraded = createDatabase(databasePath, path.resolve('drizzle'));
	cleanups.push(() => {
		upgraded.close(); 
	});
	const current = new Repository(upgraded.db);
	expect(await current.getLibrary(library.id)).toEqual(priorLibrary);
	expect((await current.getLibrary(library.id))!.name).toBe(library.name);
	expect((await current.getLibrary(library.id))!.sourceConfig).toEqual(library.sourceConfig);
	expect(await current.listScans(library.id)).toEqual(history);
	expect(await current.listTailAssessments(library.id)).toEqual(new Map(
		assessments.filter(assessment => assessment.accepted || assessment.result === 'black')
			.map(({ relativePath, ...assessment }) => [relativePath, { ...assessment, fingerprint: 'a'.repeat(64) }]),
	));
});
