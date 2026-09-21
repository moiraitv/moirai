import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ScanIssue } from '@moirai/shared';
import { attachMediaIssueIdentities, recordSidecarIdentity, type MediaIssueInputs } from '@server/scanner/media-issue-identity.js';
import type { CatalogConflictObservation, DiscoveredItem } from '@server/repository/contracts.js';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-health-identity-'));
	roots.push(root);
	return root;
}
async function identity(root: string, code: string, file: string, inputs: MediaIssueInputs, items: DiscoveredItem[] = [], conflicts: CatalogConflictObservation[] = []) {
	const issue: ScanIssue = { path: file, code, message: 'Diagnostic text is not an identity', severity: 'warning' };
	await attachMediaIssueIdentities(root, [issue], items, conflicts, inputs);
	return issue.ignoreState?.fingerprint;
}

it('binds metadata findings to media and sidecars while ignoring unrelated artwork', async () => {
	const root = await fixture();
	const inputs = { sidecars: new Map(), media: new Map([['Film.mp4', 'a'.repeat(64)]]), metadata: new Map([['Film.mp4', ['Film.nfo', 'movie.nfo']]]) };
	const initial = await identity(root, 'nfo_missing', 'Film.mp4', inputs);
	await writeFile(path.join(root, 'poster.jpg'), 'new artwork');
	expect(await identity(root, 'nfo_missing', 'Film.mp4', inputs)).toBe(initial);
	await writeFile(path.join(root, 'movie.nfo'), '<movie/>');
	expect(await identity(root, 'nfo_missing', 'Film.mp4', inputs)).not.toBe(initial);
	const metadata = await identity(root, 'nfo_invalid', 'movie.nfo', inputs);
	inputs.media.set('Film.mp4', 'b'.repeat(64));
	expect(await identity(root, 'nfo_invalid', 'movie.nfo', inputs)).not.toBe(metadata);
});

it('distinguishes missing, non-file and readable states without depending on error messages', async () => {
	const root = await fixture();
	const inputs = { sidecars: new Map(), media: new Map(), metadata: new Map() };
	const missing = await identity(root, 'media_unreadable', 'Film.mp4', inputs);
	expect(await identity(root, 'media_unreadable', 'Film.mp4', inputs)).toBe(missing);
	await mkdir(path.join(root, 'Film.mp4'));
	const directory = await identity(root, 'media_unreadable', 'Film.mp4', inputs);
	expect(directory).not.toBe(missing);
	await rm(path.join(root, 'Film.mp4'), { recursive: true });
	await writeFile(path.join(root, 'Film.mp4'), 'readable');
	expect(await identity(root, 'media_unreadable', 'Film.mp4', inputs)).not.toBe(directory);
	expect(await identity(root, 'media_unreadable', 'Film.mp4', inputs)).not.toBe(missing);
});

it('fingerprints every ordered multipart member and detects membership changes', async () => {
	const root = await fixture();
	const inputs = { sidecars: new Map(), media: new Map([['Film.part1.mp4', 'a'], ['Film.part3.mp4', 'b']]), metadata: new Map() };
	const item = { relativePath: 'Film.part1.mp4', parts: [{ relativePath: 'Film.part1.mp4' }, { relativePath: 'Film.part3.mp4' }] } as DiscoveredItem;
	const initial = await identity(root, 'multipart_incomplete', item.relativePath, inputs, [item]);
	inputs.media.set('Film.part3.mp4', 'c');
	expect(await identity(root, 'multipart_incomplete', item.relativePath, inputs, [item])).not.toBe(initial);
	inputs.media.set('Film.part3.mp4', 'b');
	item.parts.reverse();
	expect(await identity(root, 'multipart_incomplete', item.relativePath, inputs, [item])).not.toBe(initial);
	item.parts.pop();
	expect(await identity(root, 'multipart_incomplete', item.relativePath, inputs, [item])).not.toBe(initial);
});

it('binds show conflicts to all participants and their metadata', async () => {
	const root = await fixture();
	await mkdir(path.join(root, 'A'));
	await mkdir(path.join(root, 'B'));
	await writeFile(path.join(root, 'A', 'tvshow.nfo'), '<tvshow/>');
	await writeFile(path.join(root, 'B', 'tvshow.nfo'), '<tvshow/>');
	const inputs = { sidecars: new Map(), media: new Map(), metadata: new Map([['B/Episode.mp4', ['B/Episode.nfo']]]) };
	const conflicts = [{ paths: ['A', 'B'] }] as CatalogConflictObservation[];
	const initial = await identity(root, 'show_external_id_conflict', 'A', inputs, [], conflicts);
	await writeFile(path.join(root, 'B', 'Episode.nfo'), '<episodedetails/>');
	expect(await identity(root, 'show_external_id_conflict', 'A', inputs, [], conflicts)).toBe(initial);
	await writeFile(path.join(root, 'B', 'tvshow.nfo'), '<tvshow><title>Changed</title></tvshow>');
	expect(await identity(root, 'show_external_id_conflict', 'A', inputs, [], conflicts)).not.toBe(initial);
	conflicts[0]!.paths.push('C');
	expect(await identity(root, 'show_external_id_conflict', 'A', inputs, [], conflicts)).not.toBe(initial);
});

it('honors cancellation while collecting additional identities', async () => {
	const root = await fixture();
	const controller = new AbortController();
	controller.abort();
	await expect(attachMediaIssueIdentities(root, [{ path: 'Film.mp4', code: 'media_unreadable', message: 'Failure', severity: 'warning' }], [], [], { sidecars: new Map(), media: new Map(), metadata: new Map() }, controller.signal)).rejects.toThrow();
});


it('withholds ignore identity when one sidecar changed between consumers in the same scan', async () => {
	const root = await fixture();
	const inputs: MediaIssueInputs = { media: new Map(), metadata: new Map(), sidecars: new Map() };
	const file = path.join(root, 'movie.nfo');
	recordSidecarIdentity(inputs, root, file, 'a'.repeat(64));
	recordSidecarIdentity(inputs, root, file, 'b'.repeat(64));
	recordSidecarIdentity(inputs, root, file, 'a'.repeat(64));
	expect(await identity(root, 'nfo_invalid', 'movie.nfo', inputs)).toBeUndefined();
});
