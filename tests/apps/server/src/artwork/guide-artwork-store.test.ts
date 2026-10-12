import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { GUIDE_ARTWORK_MAX_BYTES, GUIDE_ARTWORK_MAX_DIMENSION } from '@moirai/shared';
import { GuideArtworkStore, GUIDE_ARTWORK_GRACE_MS, normalizeGuideArtwork } from '@server/artwork/guide-artwork-store.js';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each(['png', 'jpeg', 'webp'] as const)('fully decodes %s and normalizes to metadata-free PNG', async (format) => {
	const input = await sharp({ create: { width: 32, height: 16, channels: 4, background: '#12345680' } })
		.withMetadata().toFormat(format).toBuffer();
	const normalized = await normalizeGuideArtwork(input);
	const metadata = await sharp(normalized).metadata();
	expect(metadata).toMatchObject({ format: 'png', width: 32, height: 16 });
	expect(metadata.exif).toBeUndefined();
	await expect(sharp(normalized).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
});

it('rejects invalid data, oversized payloads, and excessive dimensions', async () => {
	await expect(normalizeGuideArtwork(Buffer.from('bad image'))).rejects.toThrow(/valid/);
	await expect(normalizeGuideArtwork(Buffer.alloc(GUIDE_ARTWORK_MAX_BYTES + 1))).rejects.toThrow(/size limit/);
	const wide = await sharp({ create: { width: GUIDE_ARTWORK_MAX_DIMENSION + 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
	await expect(normalizeGuideArtwork(wide)).rejects.toThrow(/dimension/);
	const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
	await expect(normalizeGuideArtwork(svg)).rejects.toThrow(/valid/);
});

it('keeps immutable referenced and recent assets while reconciling old orphaned files', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'guide-artwork-'));
	roots.push(root);
	const store = new GuideArtworkStore(root);
	const png = await sharp({ create: { width: 2, height: 1, channels: 4, background: 'red' } }).png().toBuffer();
	const [shared, orphan, recent] = await Promise.all([store.upload(png), store.upload(png), store.upload(png)]);
	const loadReferences = vi.fn().mockResolvedValue(new Set());
	await store.reconcile(loadReferences);
	expect(loadReferences).not.toHaveBeenCalled();
	expect(new Set([shared, orphan, recent]).size).toBe(3);
	const old = new Date(Date.now() - GUIDE_ARTWORK_GRACE_MS - 1000);
	await Promise.all([shared, orphan].map(id => utimes(path.join(root, `${id}.png`), old, old)));
	const temporary = path.join(root, `${orphan}.png.tmp`);
	await writeFile(temporary, png);
	await utimes(temporary, old, old);
	await store.mutate(() => store.reconcile(async () => new Set([shared])));
	expect(await store.exists(shared)).toBe(true);
	expect(await store.exists(recent)).toBe(true);
	expect(await store.exists(orphan)).toBe(false);
	await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
	await expect(store.exists('../outside')).rejects.toThrow(/identifier/);
	await store.mutate(() => store.reconcile(async () => new Set()));
	expect(await store.exists(shared)).toBe(false);
});

it('enforces the byte limit after normalization, not just on the compressed upload', async () => {
	const side = Math.ceil(Math.sqrt(GUIDE_ARTWORK_MAX_BYTES / 3) * 1.1);
	const compressed = await sharp(randomBytes(side * side * 3), { raw: { width: side, height: side, channels: 3 } })
		.jpeg({ quality: 100 }).toBuffer();
	expect(compressed.length).toBeLessThan(GUIDE_ARTWORK_MAX_BYTES);
	await expect(normalizeGuideArtwork(compressed)).rejects.toThrow(/Normalized.*size limit/);
});
