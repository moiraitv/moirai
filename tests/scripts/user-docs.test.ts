import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	approveReviews,
	assertUserDocsReviewed,
	listOutstandingReviews,
	loadUserDocPages,
	pageDigest,
	writeUserDocsManifest,
	migrateReviews,
	type UserDocsPaths,
} from '@scripts/user-docs.js';

const cleanups: string[] = [];

/** Create a minimal isolated guide and review registry. */
async function fixture(): Promise<{ paths: UserDocsPaths; pagePath: string; screenshotPath: string }> {
	const projectRoot = await mkdtemp(path.join(tmpdir(), 'moirai-user-docs-'));
	cleanups.push(projectRoot);
	const sourceRoot = path.join(projectRoot, 'apps/docs/src');
	const publicRoot = path.join(projectRoot, 'apps/docs/public');
	const screenshotPath = path.join(publicRoot, 'screenshots/example.png');
	const reviewPath = path.join(projectRoot, 'apps/docs/reviews.json');
	const pagePath = path.join(sourceRoot, 'example.md');
	await mkdir(path.dirname(screenshotPath), { recursive: true });
	await mkdir(sourceRoot, { recursive: true });
	await writeFile(path.join(projectRoot, 'package.json'), '{"version":"9.8.7"}\n');
	await writeFile(reviewPath, '{"version":1,"reviews":{}}\n');
	await writeFile(screenshotPath, 'first image');
	await writeFile(pagePath, [
		'---',
		'id: example',
		'title: Example',
		'description: An example page.',
		'contextual: true',
		'---',
		'',
		'# Example',
		'',
		'![Example](/help/screenshots/example.png)',
		'',
	].join('\n'));
	return {
		pagePath,
		screenshotPath,
		paths: {
			projectRoot,
			sourceRoot,
			publicRoot,
			reviewPath,
			generatedManifestPath: path.join(publicRoot, 'contextual-help.json'),
			generatedReviewPath: path.join(sourceRoot, 'review.md'),
			requiredContextualTopicIds: ['example'],
		},
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(cleanups.splice(0).map((directory) => rm(directory, {
		recursive: true,
		force: true,
	})));
});

describe('user documentation review tracking', () => {
	it('migrates matching legacy approvals without changing approval times or read-only commands', async () => {
		const { paths, pagePath } = await fixture();
		const digest = await pageDigest(await readFile(pagePath, 'utf8'), paths.publicRoot);
		const reviewedAt = '2026-01-01T00:00:00.000Z';
		const legacy = JSON.stringify({ version: 1, reviews: { example: { digest, reviewedAt } } });
		await writeFile(paths.reviewPath, legacy);
		await loadUserDocPages(paths);
		expect(await readFile(paths.reviewPath, 'utf8')).toBe(legacy);
		await migrateReviews(paths);
		const migrated = await readFile(paths.reviewPath, 'utf8');
		const registry = JSON.parse(migrated);
		expect(registry.version).toBe(2);
		for (const approval of Object.values(registry.reviews.example.components)) {
			expect(approval).toMatchObject({ reviewedAt });
		}
		await migrateReviews(paths);
		expect(await readFile(paths.reviewPath, 'utf8')).toBe(migrated);
		expect((await loadUserDocPages(paths))[0]?.reviewReasons).toEqual([]);
	});

	it('preserves mismatched legacy approvals as unknown instead of inventing baselines', async () => {
		const { paths } = await fixture();
		const old = { digest: 'a'.repeat(64), reviewedAt: '2026-01-01T00:00:00.000Z' };
		await writeFile(paths.reviewPath, JSON.stringify({ version: 1, reviews: { example: old } }));
		await migrateReviews(paths);
		expect(JSON.parse(await readFile(paths.reviewPath, 'utf8')).reviews.example).toEqual(old);
		expect((await loadUserDocPages(paths))[0]?.reviewReasons).toEqual(['unknown']);
		await expect(assertUserDocsReviewed(paths)).rejects.toThrow();
	});

	it.each([
		['text'], ['screenshots'], ['icons'], ['text', 'screenshots'], ['screenshots', 'icons'], ['text', 'screenshots', 'icons'],
	])('classifies changed components %j and exposes reasons to all generated output', async (...categories: string[]) => {
		const { paths, pagePath, screenshotPath } = await fixture();
		const icon = path.join(paths.publicRoot, 'icons/library.svg');
		await mkdir(path.dirname(icon), { recursive: true });
		await writeFile(icon, '<svg/>');
		await writeFile(pagePath, `${await readFile(pagePath, 'utf8')}\n![](/icons/library.svg) Library\n`);
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		await approveReviews(['example'], false, paths);
		if (categories.includes('text')) {
			await writeFile(pagePath, `${await readFile(pagePath, 'utf8')}Changed prose.\n`);
		}
		if (categories.includes('screenshots')) {
			await writeFile(screenshotPath, 'changed screenshot');
		}
		if (categories.includes('icons')) {
			await writeFile(icon, '<svg><path/></svg>');
		}
		expect((await loadUserDocPages(paths))[0]?.reviewReasons).toEqual(categories);
		await writeUserDocsManifest(paths);
		const manifest = JSON.parse(await readFile(paths.generatedManifestPath, 'utf8'));
		expect(manifest.pages[0].reviewReasons).toEqual(categories);
		expect(manifest.topics.example.reviewReasons).toEqual(categories);
		await listOutstandingReviews(true, paths);
		expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])[0].reviewReasons).toEqual(categories);
		await expect(assertUserDocsReviewed(paths)).rejects.toThrow();
	});

	it('flags initial pages, reference changes, missing assets, and shared image changes', async () => {
		const { paths, pagePath, screenshotPath } = await fixture();
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		expect((await loadUserDocPages(paths))[0]?.reviewReasons).toEqual(['initial']);
		const source = await readFile(pagePath, 'utf8');
		await writeFile(path.join(paths.sourceRoot, 'second.md'), source.replace('id: example', 'id: second'));
		await approveReviews([], true, paths);
		await writeFile(screenshotPath, 'shared change');
		expect((await loadUserDocPages(paths)).map((page) => page.reviewReasons)).toEqual([['screenshots'], ['screenshots']]);
		await approveReviews([], true, paths);
		await writeFile(pagePath, source.replace('![Example](/help/screenshots/example.png)', ''));
		expect((await loadUserDocPages(paths))[0]?.reviewReasons).toEqual(['text', 'screenshots']);
		await approveReviews(['example'], false, paths);
		await writeFile(pagePath, source);
		expect((await loadUserDocPages(paths))[0]?.reviewReasons).toEqual(['text', 'screenshots']);
		await rm(screenshotPath);
		await expect(loadUserDocPages(paths)).rejects.toThrow();
	});
	it('serves contextual icons under help and includes their bytes in review digests', async () => {
		const { paths, pagePath } = await fixture();
		const iconPath = path.join(paths.publicRoot, 'icons/library.svg');
		await mkdir(path.dirname(iconPath), { recursive: true });
		await writeFile(iconPath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
		const source = `${await readFile(pagePath, 'utf8')}\n![](/icons/library.svg) Library\n`;
		await writeFile(pagePath, source);
		await writeUserDocsManifest(paths);
		const manifest = JSON.parse(await readFile(paths.generatedManifestPath, 'utf8'));
		expect(manifest.topics.example.html).toContain('src="/help/icons/library.svg"');
		expect(manifest.topics.example.html).toContain('docs-term-badge');
		const digest = await pageDigest(source, paths.publicRoot);
		await writeFile(iconPath, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>');
		expect(await pageDigest(source, paths.publicRoot)).not.toBe(digest);
	});

	it('renders contextual screenshots and guide links under the bundled help path', async () => {
		const { paths, pagePath } = await fixture();
		await writeFile(pagePath, `${await readFile(pagePath, 'utf8')}\n![Screenshot](/screenshots/example.png)\n[Read more](/example)\n<script>alert(1)</script>\n`);
		await writeUserDocsManifest(paths);
		const manifest = JSON.parse(await readFile(paths.generatedManifestPath, 'utf8'));
		expect(manifest.topics.example.html).toContain('src="/help/screenshots/example.png"');
		expect(manifest.topics.example.html).toContain('href="/help/example.html"');
		expect(manifest.topics.example.html).not.toContain('<script>');
	});

	it('normalizes line endings and includes screenshot bytes in page digests', async () => {
		const { paths, screenshotPath } = await fixture();
		const source = await readFile(path.join(paths.sourceRoot, 'example.md'), 'utf8');
		expect(await pageDigest(source, paths.publicRoot)).toBe(
			await pageDigest(source.replaceAll('\n', '\r\n'), paths.publicRoot),
		);

		const before = await pageDigest(source, paths.publicRoot);
		await writeFile(screenshotPath, 'regenerated image');
		expect(await pageDigest(source, paths.publicRoot)).not.toBe(before);
	});

	it('lists missing approvals, records an explicit approval, and invalidates edited prose', async () => {
		const { paths, pagePath } = await fixture();
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		expect(await listOutstandingReviews(false, paths)).toHaveLength(1);
		expect(log).toHaveBeenCalledWith('1 user-guide page(s) need review:');

		await approveReviews(['example'], false, paths);
		expect((await loadUserDocPages(paths))[0]?.reviewStatus).toBe('reviewed');

		await writeFile(pagePath, `${await readFile(pagePath, 'utf8')}A newly edited instruction.\n`);
		expect((await loadUserDocPages(paths))[0]?.reviewStatus).toBe('needs-review');
	});

	it('approves all current fixture digests without approving repository documentation', async () => {
		const { paths } = await fixture();
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		await expect(assertUserDocsReviewed(paths)).rejects.toThrow(
			'Production build blocked by unreviewed user documentation.',
		);
		await approveReviews([], true, paths);
		await expect(assertUserDocsReviewed(paths)).resolves.toBeUndefined();

		const registry = JSON.parse(await readFile(paths.reviewPath, 'utf8')) as {
			reviews: Record<string, { digest: string; reviewedAt: string }>;
		};
		expect(registry.reviews.example?.digest).toMatch(/^[a-f0-9]{64}$/u);
		expect(registry.reviews.example?.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
	});
});
