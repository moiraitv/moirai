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
