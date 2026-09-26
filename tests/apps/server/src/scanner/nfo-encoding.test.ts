import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ScanIssue } from '@moirai/shared';
import { readGroupNfo, readNfo } from '@server/scanner/on-disk-nfo.js';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each(['utf8', 'utf16le', 'latin1'] as const)('ingests item and group NFOs using %s bytes', async encoding => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-nfo-encoding-'));
	roots.push(root);
	const stem = path.join(root, 'Film');
	const declared = encoding === 'latin1' ? 'ISO-8859-1' : encoding === 'utf16le' ? 'UTF-16' : 'UTF-8';
	const text = `<?xml version="1.0" encoding="${declared}"?><movie><title>Café</title><plot>Préservé</plot></movie>`;
	const bytes = Buffer.from(text, encoding);
	await writeFile(`${stem}.nfo`, encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), bytes]) : bytes);
	const inputs = { media: new Map(), metadata: new Map(), sidecars: new Map() };
	const item = await readNfo(`${stem}.mkv`, root, stem, 'movies', inputs);
	expect(item).toMatchObject({ status: 'complete', parsed: { title: 'Café', plot: 'Préservé' }, issue: null });
	const issues: ScanIssue[] = [];
	expect(await readGroupNfo(`${stem}.nfo`, root, issues, inputs)).toMatchObject({ title: 'Café', plot: 'Préservé' });
	expect(issues).toEqual([]);
});

it.each([
	Buffer.from('<?xml encoding="UTF-8"?><movie><title>Caf\xe9</title></movie>', 'latin1'),
	Buffer.from('\ufeff<?xml encoding="ISO-8859-1"?><movie/>'),
	Buffer.from('<?xml encoding="unsupported"?><movie/>'),
])('reports invalid encoding during real NFO ingestion (%j)', async bytes => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-nfo-invalid-'));
	roots.push(root);
	const stem = path.join(root, 'Film');
	await writeFile(`${stem}.nfo`, bytes);
	const inputs = { media: new Map(), metadata: new Map(), sidecars: new Map() };
	expect(await readNfo(`${stem}.mkv`, root, stem, 'movies', inputs)).toMatchObject({
		status: 'invalid', parsed: null, issue: { code: 'nfo_invalid' },
	});
	const issues: ScanIssue[] = [];
	expect(await readGroupNfo(`${stem}.nfo`, root, issues, inputs)).toBeNull();
	expect(issues).toHaveLength(1);
});


it.each(['windows-1252', 'windows-1251', 'shift-jis', 'gb18030', 'big5'])('ingests declared %s metadata without changing its characters', async encoding => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-declared-nfo-'));
	roots.push(root);
	const stem = path.join(root, 'Film');
	const raw = await readFile(`tests/fixtures/media-text/${encoding}.nfo`);
	const expected = await readFile(`tests/fixtures/media-text/${encoding}.nfo.utf8.txt`, 'utf8');
	await writeFile(`${stem}.nfo`, raw);
	const inputs = { media: new Map(), metadata: new Map(), sidecars: new Map() };
	const result = await readNfo(`${stem}.mkv`, root, stem, 'movies', inputs);
	expect(result.status).toBe('complete');
	expect(result.parsed?.title).toBe(/<title>(.*?)<\/title>/.exec(expected)![1]);
	expect(result.parsed?.plot).toBe(/<plot>(.*?)<\/plot>/.exec(expected)![1]!.trim());
	const issues: ScanIssue[] = [];
	expect(await readGroupNfo(`${stem}.nfo`, root, issues, inputs)).toEqual(result.parsed);
	expect(issues).toEqual([]);
});
