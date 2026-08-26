import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSourceFile, SourceFileError } from '@server/media/source-file.js';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('safe source files', () => {
	it('rejects symlinks and paths outside the configured source root', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-source-'));
		roots.push(root);
		const sourceRoot = path.join(root, 'media');
		await mkdir(sourceRoot);
		await writeFile(path.join(root, 'outside.txt'), 'outside');
		await symlink(path.join(root, 'outside.txt'), path.join(sourceRoot, 'media-link'));

		await expect(openSourceFile(sourceRoot, 'media-link')).rejects.toMatchObject({
			reason: 'symlink',
		});
		await expect(openSourceFile(sourceRoot, '../outside.txt')).rejects.toMatchObject({
			reason: 'outside-root',
		});
	});

	it('keeps reading the validated descriptor after the source pathname is replaced', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-source-'));
		roots.push(root);
		const source = path.join(root, 'source.txt');
		const replacement = path.join(root, 'replacement.txt');
		await writeFile(source, 'original');
		await writeFile(replacement, 'replacement');
		const opened = await openSourceFile(root, source);
		await rename(replacement, source);
		try {
			expect((await opened.handle.readFile()).toString()).toBe('original');
		}
		finally {
			await opened.handle.close();
		}
	});

	it('rejects files above a caller-provided byte limit', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-source-'));
		roots.push(root);
		await writeFile(path.join(root, 'large.txt'), 'too large');
		await expect(openSourceFile(root, 'large.txt', 2)).rejects.toBeInstanceOf(SourceFileError);
		await expect(openSourceFile(root, 'large.txt', 2)).rejects.toMatchObject({ reason: 'too-large' });
	});
});
