import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import matter from 'gray-matter';
import { afterEach, expect, it } from 'vitest';
import { approveReviews, loadUserDocPages, loadReviewRegistry, writeUserDocsManifest, type UserDocsPaths } from '@scripts/user-docs.js';
import { buildReviewChanges } from '@scripts/user-docs-review.js';

const execute = promisify(execFile);
const roots: string[] = [];

async function fixture() {
	const projectRoot = await mkdtemp(path.join(tmpdir(), 'moirai-review-comparison-'));
	roots.push(projectRoot);
	const sourceRoot = path.join(projectRoot, 'apps/docs/src');
	const publicRoot = path.join(sourceRoot, 'public');
	const paths: UserDocsPaths = {
		projectRoot, sourceRoot, publicRoot,
		reviewPath: path.join(projectRoot, 'apps/docs/reviews.json'),
		generatedManifestPath: path.join(publicRoot, 'contextual-help.json'),
		generatedReviewPath: path.join(sourceRoot, 'review.md'),
		requiredContextualTopicIds: [],
	};
	await mkdir(path.join(publicRoot, 'screenshots'), { recursive: true });
	await writeFile(path.join(projectRoot, 'package.json'), '{"version":"1"}');
	await writeFile(paths.reviewPath, '{"version":2,"reviews":{}}');
	const pagePath = path.join(sourceRoot, 'example.md');
	const imagePath = path.join(publicRoot, 'screenshots/example.png');
	const source = '---\nid: example\ntitle: Example\ndescription: Review fixture\n---\n\n# Example\n\nOld paragraph.\n\n![Example](/screenshots/example.png)\n';
	await writeFile(pagePath, source);
	await writeFile(imagePath, 'approved image');
	const git = (...args: string[]) => execute('git', args, { cwd: projectRoot });
	const commit = async () => {
		await git('add', '.');
		await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
	};
	const changes = async () => buildReviewChanges(paths, (await loadUserDocPages(paths)).filter(page => page.reviewStatus === 'needs-review'), (await loadReviewRegistry(paths.reviewPath)).reviews);
	return { paths, pagePath, imagePath, source, git, commit, changes };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('compares pending committed and uncommitted changes with the verified approval, preserving the registry', async () => {
	const f = await fixture();
	await f.git('init', '-q');
	await approveReviews(['example'], false, f.paths);
	await f.commit();
	const registry = await readFile(f.paths.reviewPath, 'utf8');
	await writeFile(f.imagePath, 'pending committed image');
	await f.commit();
	await writeFile(f.pagePath, f.source.replace('Old paragraph.', 'New paragraph with <script>literal source</script>.'));
	const [change] = await f.changes();
	expect(change?.baseline).toBe('approved');
	expect(change?.textDiff).toContain('-Old paragraph.');
	expect(change?.textDiff).toContain('+New paragraph with <script>literal source</script>.');
	for (const [version, expected] of [['before', 'approved image'], ['after', 'pending committed image']] as const) {
		const url = change!.images[0]![version]!;
		expect(await readFile(path.join(f.paths.publicRoot, url.replace('/help/', '')), 'utf8')).toBe(expected);
	}
	await writeUserDocsManifest(f.paths);
	const generated = matter(await readFile(f.paths.generatedReviewPath, 'utf8'));
	expect(JSON.parse(generated.data.reviewChanges)).toEqual([change]);
	expect(await readFile(f.paths.reviewPath, 'utf8')).toBe(registry);
});

it('includes removed and added images without presenting unchanged images as changes', async () => {
	const f = await fixture();
	await f.git('init', '-q');
	const keepPath = path.join(f.paths.publicRoot, 'screenshots/keep.png');
	await writeFile(keepPath, 'keep');
	await writeFile(f.pagePath, `${f.source}\n![Keep](/screenshots/keep.png)\n`);
	await approveReviews(['example'], false, f.paths);
	await f.commit();
	await writeFile(path.join(f.paths.publicRoot, 'screenshots/new.png'), 'new');
	await writeFile(f.pagePath, `${f.source.replace('/screenshots/example.png', '/screenshots/new.png')}\n![Keep](/screenshots/keep.png)\n`);
	const [change] = await f.changes();
	expect(change?.images.map(image => image.name)).toEqual(['screenshots/example.png', 'screenshots/new.png']);
	expect(change?.images[0]?.after).toBeNull();
	expect(change?.images[1]?.before).toBeNull();
});

it('labels missing history explicitly instead of comparing with an unapproved version', async () => {
	const f = await fixture();
	await approveReviews(['example'], false, f.paths);
	await writeFile(f.imagePath, 'new image');
	const [change] = await f.changes();
	expect(change).toMatchObject({ baseline: 'unavailable', textDiff: [] });
	expect(change?.images[0]?.before).toBeNull();
});

it('shows a new page as additions and clears obsolete generated assets when the queue empties', async () => {
	const f = await fixture();
	const [change] = await f.changes();
	expect(change?.baseline).toBe('initial');
	expect(change?.textDiff).toContain('+Old paragraph.');
	const oldAsset = path.join(f.paths.publicRoot, change!.images[0]!.after!.replace('/help/', ''));
	await approveReviews(['example'], false, f.paths);
	expect(await f.changes()).toEqual([]);
	await expect(readFile(oldAsset)).rejects.toThrow();
});

it('reserves the approved PNG dimensions even when an image is removed', async () => {
	const f = await fixture();
	await f.git('init', '-q');
	await writeFile(f.imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxkAAAAASUVORK5CYII=', 'base64'));
	await approveReviews(['example'], false, f.paths);
	await f.commit();
	await writeFile(f.pagePath, f.source.replace('![Example](/screenshots/example.png)', 'Image removed.'));
	const [change] = await f.changes();
	expect(change?.images[0]).toMatchObject({ aspectRatio: 1, after: null });
});

it('omits approved screenshots while retaining pending text changes', async () => {
	const f = await fixture();
	await f.git('init', '-q');
	await approveReviews(['example'], false, f.paths);
	await f.commit();
	await writeFile(f.imagePath, 'approved replacement image');
	await writeFile(f.pagePath, f.source.replace('Old paragraph.', 'Pending paragraph.'));
	const [page] = await loadUserDocPages(f.paths);
	const registry = await loadReviewRegistry(f.paths.reviewPath);
	registry.reviews.example!.components!.screenshots = {
		digest: page!.componentDigests.screenshots, reviewedAt: new Date().toISOString(),
	};
	await writeFile(f.paths.reviewPath, JSON.stringify(registry));
	const [change] = await f.changes();
	expect(change?.images).toEqual([]);
	expect(change?.textDiff).toContain('+Pending paragraph.');
	expect((await loadUserDocPages(f.paths))[0]?.reviewReasons).toEqual(['text']);
});
