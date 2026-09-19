import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtworkCache, type ArtworkCacheOwner } from '@server/artwork/artwork-cache.js';
import { openSourceFile } from '@server/media/source-file.js';

const roots: string[] = [];
const owner: ArtworkCacheOwner = {
	libraryId: '0da47119-382e-4bf1-9cdf-009ce933bf64',
	kind: 'items',
	id: '2be7a2b9-81b5-4a72-a3d8-ad4e6394dd25',
	relativePath: 'Film/poster.png',
	cacheVersion: 'fixture-version',
};

async function image(color: string, width = 32): Promise<Buffer> {
	return sharp({ create: { width, height: width * 2, channels: 4, background: color } })
		.png()
		.toBuffer();
}

async function store(
	cache: ArtworkCache,
	root: string,
	cacheOwner: ArtworkCacheOwner,
	sourcePath: string,
	variant: Parameters<ArtworkCache['store']>[2] = 'card',
	density: Parameters<ArtworkCache['store']>[3] = 1,
): Promise<string | null> {
	const source = await openSourceFile(root, sourcePath);
	try {
		return await cache.store(cacheOwner, source, variant, density);
	}
	finally {
		await source.handle.close();
	}
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ArtworkCache', () => {
	it('serves a bounded JPEG hit after the source disappears', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-artwork-cache-'));
		roots.push(root);
		const source = path.join(root, 'poster.png');
		await writeFile(source, await image('#ff0000'));
		const cache = new ArtworkCache(path.join(root, 'cache'), 1024 * 1024, 1024 * 1024);
		const cached = await store(cache, root, owner, source, 'thumb', 3);
		expect(cached).not.toBeNull();
		await rm(source);
		expect(await cache.get(owner, 'thumb', 3)).toBe(cached);
		expect((await sharp(await readFile(cached!)).metadata()).format).toBe('jpeg');
	});

	it('isolates artwork roles across concurrent fills, stale fallback, and replacement cleanup', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-artwork-roles-'));
		roots.push(root);
		const cache = new ArtworkCache(path.join(root, 'cache'), 1024 * 1024, 1024 * 1024);
		const owners: ArtworkCacheOwner[] = [
			owner,
			...(['poster', 'landscape', 'fanart'] as const).map((role) => ({ ...owner, role })),
		];
		const sources = await Promise.all(owners.map(async (_, index) => {
			const source = path.join(root, `source-${index}.png`);
			await writeFile(source, await image('#ff0000', 32 + index));
			return source;
		}));
		const cached = await Promise.all(owners.map((entry, index) => store(cache, root, entry, sources[index]!)));
		expect(new Set(cached).size).toBe(owners.length);
		for (const [index, entry] of owners.entries()) {
			expect(await cache.get(entry)).toBe(cached[index]);
			expect((await sharp(cached[index]!).metadata()).width).toBe(32 + index);
		}

		// Reopen the cache to exercise stale lookup from its persisted inventory.
		const reopened = new ArtworkCache(path.join(root, 'cache'), 1024 * 1024, 1024 * 1024);
		const replacement = { ...owners[3]!, cacheVersion: 'replacement' };
		expect(await reopened.getStale(replacement)).toBe(cached[3]);
		await store(reopened, root, replacement, sources[3]!);
		expect(await reopened.get(owners[3]!)).toBeNull();
		expect(await reopened.getStale(replacement)).toBeNull();
		for (const [index, entry] of owners.slice(0, 3).entries()) {
			expect(await reopened.get(entry)).toBe(cached[index]);
		}

		await reopened.purgeOwner(owner.libraryId, owner.kind, owner.id);
		for (const entry of [...owners, replacement]) {
			expect(await reopened.get(entry)).toBeNull();
		}
	});

	it('builds separate high-DPI variants without enlarging small source images', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-artwork-cache-'));
		roots.push(root);
		const source = path.join(root, 'poster.png');
		await writeFile(source, await image('#00ff00', 100));
		const cache = new ArtworkCache(path.join(root, 'cache'), 1024 * 1024, 1024 * 1024);
		const one = await store(cache, root, owner, source, 'card', 1);
		const three = await store(cache, root, owner, source, 'card', 3);
		expect(one).not.toBe(three);
		expect((await sharp(one!).metadata()).width).toBe(100);
		expect((await sharp(three!).metadata()).width).toBe(100);
	});

	it('does not cache a source image larger than the configured entry limit', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-artwork-cache-'));
		roots.push(root);
		const source = path.join(root, 'poster.png');
		const bytes = await image('#0000ff');
		await writeFile(source, bytes);
		const cache = new ArtworkCache(path.join(root, 'cache'), 1024 * 1024, bytes.length - 1);
		expect(await store(cache, root, owner, source)).toBeNull();
	});

	it('rebuilds an externally purged entry on the next request', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-artwork-cache-'));
		roots.push(root);
		const source = path.join(root, 'poster.png');
		await writeFile(source, await image('#ff00ff'));
		const cache = new ArtworkCache(path.join(root, 'cache'), 1024 * 1024, 1024 * 1024);
		const cached = await store(cache, root, owner, source);
		await unlink(cached!);
		expect(await cache.get(owner)).toBeNull();
		expect(await store(cache, root, owner, source)).not.toBeNull();
	});

	it('keeps a prior variant as fallback until that replacement variant is cached', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-artwork-cache-'));
		roots.push(root);
		const source = path.join(root, 'poster.png');
		await writeFile(source, await image('#00ffff'));
		const cache = new ArtworkCache(path.join(root, 'cache'), 1024 * 1024, 1024 * 1024);
		const original = await store(cache, root, owner, source, 'card', 2);
		const changedOwner = { ...owner, cacheVersion: 'changed-version' };
		expect(await cache.getStale(changedOwner, 'card', 2)).toBe(original);
		await writeFile(source, await image('#ffff00'));
		await store(cache, root, changedOwner, source, 'card', 2);
		expect(await cache.get(owner, 'card', 2)).toBeNull();
	});

	it('evicts least-recently-used variants to keep total bytes bounded', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-artwork-cache-'));
		roots.push(root);
		const firstSource = path.join(root, 'first.png');
		const secondSource = path.join(root, 'second.png');
		await writeFile(firstSource, await image('#112233'));
		await writeFile(secondSource, await image('#445566'));
		const expected = await sharp(firstSource).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
		const cache = new ArtworkCache(path.join(root, 'cache'), expected.length + 64, 1024 * 1024);
		await store(cache, root, owner, firstSource);
		const secondOwner = {
			...owner,
			id: '7da93b6f-0419-4e9c-9f8d-d7cc259eedc4',
			cacheVersion: 'second-version',
		};
		await store(cache, root, secondOwner, secondSource);
		expect(await cache.get(owner)).toBeNull();
		expect(await cache.get(secondOwner)).not.toBeNull();
	});

	it('does not release capacity reserved by another cache fill when a fill is rejected', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-artwork-cache-'));
		roots.push(root);
		const source = path.join(root, 'poster.png');
		await writeFile(source, await image('#334455', 100));
		const cache = new ArtworkCache(path.join(root, 'cache'), 1, 1024 * 1024);
		const internal = cache as unknown as {
			reservedBytes: number;
			reserve(bytes: number): Promise<boolean>;
		};
		internal.reservedBytes = 1;

		expect(await store(cache, root, owner, source)).toBeNull();
		expect(internal.reservedBytes).toBe(1);
	});

	it('purges confirmed and orphaned catalog owners', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-artwork-cache-'));
		roots.push(root);
		const source = path.join(root, 'poster.png');
		await writeFile(source, await image('#778899'));
		const cache = new ArtworkCache(path.join(root, 'cache'), 1024 * 1024, 1024 * 1024);
		await store(cache, root, owner, source);
		await cache.purgeOwner(owner.libraryId, owner.kind, owner.id);
		expect(await cache.get(owner)).toBeNull();

		await store(cache, root, owner, source);
		await cache.pruneOrphans(async () => new Set());
		expect(await cache.get(owner)).toBeNull();
	});
});
