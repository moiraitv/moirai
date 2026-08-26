import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	MediaPreviewError,
	mediaMimeType,
	parseMediaRange,
	resolveMediaFile,
} from '@server/media/media-preview.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('media preview helpers', () => {
	it('parses the single byte range forms used by browser media controls', () => {
		const size = 100;
		expect(parseMediaRange(undefined, size)).toBeNull();
		expect(parseMediaRange('bytes=10-19', size)).toEqual({ start: 10, end: 19 });
		expect(parseMediaRange('bytes=90-', size)).toEqual({ start: 90, end: 99 });
		expect(parseMediaRange('bytes=-10', size)).toEqual({ start: 90, end: 99 });
		expect(parseMediaRange('bytes=95-200', size)).toEqual({ start: 95, end: 99 });
	});

	it.each(['bytes=100-101', 'bytes=20-10', 'bytes=-0', 'bytes=0-1,4-5', 'items=0-1'])(
		'rejects an unsatisfiable or unsupported range: %s',
		(value) => {
			expect(() => parseMediaRange(value, 100)).toThrow(MediaPreviewError);
		},
	);

	it('maps indexed media extensions to browser response types', () => {
		expect(mediaMimeType('preview.mp4')).toBe('video/mp4');
		expect(mediaMimeType('preview.webm')).toBe('video/webm');
		expect(mediaMimeType('preview.mkv')).toBe('video/x-matroska');
	});

	it('rejects symlinked files and paths outside the configured root', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-preview-'));
		cleanupPaths.push(root);
		const mediaRoot = path.join(root, 'media');
		await mkdir(mediaRoot);
		const outside = path.join(root, 'outside.mp4');
		await writeFile(outside, 'outside');
		await symlink(outside, path.join(mediaRoot, 'linked.mp4'));

		await expect(
			resolveMediaFile({
				libraryId: 'library',
				relativePath: 'linked.mp4',
				sourceType: 'on-disk',
				scanRoot: mediaRoot,
			}),
		).rejects.toMatchObject({ statusCode: 403 });
		await expect(
			resolveMediaFile({
				libraryId: 'library',
				relativePath: '../outside.mp4',
				sourceType: 'on-disk',
				scanRoot: mediaRoot,
			}),
		).rejects.toMatchObject({ statusCode: 403 });
	});

	it('distinguishes a missing item from an unavailable source root', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-preview-'));
		cleanupPaths.push(root);
		const mediaRoot = path.join(root, 'media');
		await mkdir(mediaRoot);
		const owner = {
			libraryId: 'library',
			relativePath: 'missing.mp4',
			sourceType: 'on-disk',
			scanRoot: mediaRoot,
		};
		await expect(resolveMediaFile(owner)).rejects.toMatchObject({ statusCode: 404 });
		await rm(mediaRoot, { recursive: true, force: true });
		await expect(resolveMediaFile(owner)).rejects.toMatchObject({ statusCode: 503 });
	});
});
