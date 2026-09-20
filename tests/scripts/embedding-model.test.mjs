import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireModelFile } from '../../scripts/embedding-model.mjs';

const directories = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'moirai-model-build-'));
	directories.push(directory);
	const bytes = Buffer.from('verified build asset');
	return { filename: path.join(directory, 'bundle', 'model.onnx'), cache: path.join(directory, 'cached.onnx'),
		bytes, hash: createHash('sha256').update(bytes).digest('hex'), url: 'https://example.invalid/pinned/model.onnx' };
}

it('packages verified cached assets and rebuilds offline without requesting the network', async () => {
	const f = await fixture();
	const fetch = vi.fn(() => {
		throw new Error('Network unavailable');
	});
	vi.stubGlobal('fetch', fetch);
	await writeFile(f.cache, f.bytes);
	await acquireModelFile(f.filename, f.url, f.hash, f.cache);
	expect(await readFile(f.filename)).toEqual(f.bytes);
	await rm(f.cache);
	await acquireModelFile(f.filename, f.url, f.hash);
	expect(fetch).not.toHaveBeenCalled();
});

it('downloads missing assets during packaging and verifies their checksum before publishing', async () => {
	const f = await fixture();
	const fetch = vi.fn(async () => new Response(f.bytes));
	vi.stubGlobal('fetch', fetch);
	await writeFile(f.cache, 'corrupt cached asset');
	await acquireModelFile(f.filename, f.url, f.hash, f.cache);
	expect(fetch).toHaveBeenCalledWith(f.url);
	expect(await readFile(f.filename)).toEqual(f.bytes);
});

it('fails packaging for corrupt downloads or unavailable assets instead of shipping an incomplete model', async () => {
	const f = await fixture();
	vi.stubGlobal('fetch', vi.fn(async () => new Response('wrong model')));
	await expect(acquireModelFile(f.filename, f.url, f.hash)).rejects.toThrow('checksum mismatch');
	await expect(readFile(f.filename)).rejects.toMatchObject({ code: 'ENOENT' });
	vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
	await expect(acquireModelFile(f.filename, f.url, f.hash)).rejects.toThrow('503');
});
