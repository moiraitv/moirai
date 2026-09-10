import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { reviewChangesFrontmatter, type ReviewChange } from '../../../scripts/user-docs-review';

/** Disposable guide build that exercises the production theme without changing approvals. */
const root = path.resolve('test-results/docs-review-fixture');

/** Build deterministic pending and empty review pages using the real comparison components. */
export async function buildReviewFixture(): Promise<void> {
	await rm(root, { recursive: true, force: true });
	await mkdir(path.join(root, '.vitepress/theme'), { recursive: true });
	await mkdir(path.join(root, 'public'), { recursive: true });
	await writeFile(path.join(root, '.vitepress/config.mts'), `export default { base: '/review-fixture/', outDir: '${root}/dist' };`);
	await writeFile(path.join(root, '.vitepress/theme/index.ts'), `export { default } from ${JSON.stringify(path.resolve('apps/docs/.vitepress/theme/index.ts'))};`);
	for (const [version, color] of [['before', '#225588'], ['after', '#228855']]) {
		await writeFile(path.join(root, 'public', `${version}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="${color}"/><text x="40" y="80" fill="white" font-size="36">${version}</text></svg>`);
	}
	const changes: ReviewChange[] = [{
		id: 'fixture.review', title: 'Review fixture', href: '/review-fixture/empty.html', baseline: 'approved',
		textDiff: ['@@ -1 +1 @@', '-Old paragraph.', '+New paragraph with <script>literal markup</script>.'],
		images: [{ name: 'screenshots/example.svg', before: '/review-fixture/before.svg', after: '/review-fixture/after.svg', aspectRatio: 800 / 450 }],
	}];
	for (const [name, entries] of [['pending', changes], ['empty', []]] as const) {
		await writeFile(path.join(root, `${name}.md`), `---\ntitle: Review fixture\nreviewChanges: ${reviewChangesFrontmatter([...entries])}\n---\n\n# Review fixture\n\n<ReviewChanges />\n`);
	}
	execFileSync(process.execPath, [path.resolve('node_modules/vitepress/bin/vitepress.js'), 'build', root], { stdio: 'inherit' });
}

/** Serve the isolated fixture build through browser interception on the test origin. */
export async function serveReviewFixture(page: Page): Promise<void> {
	await page.route('**/review-fixture/**', async (route) => {
		const relative = new URL(route.request().url()).pathname.slice('/review-fixture/'.length);
		await route.fulfill({ path: path.join(root, 'dist', relative) });
	});
}
