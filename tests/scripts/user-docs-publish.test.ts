import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { publishScreenshots, screenshotNames } from '../e2e/documentation/publish';
import { helpReviewLabel } from '../../apps/web/src/help-review';

it('does not publish an incomplete capture set and publishes a complete set', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'docs-publish-'));
	try {
		const stage = path.join(root, 'stage');
		const destination = path.join(root, 'guide');
		await mkdir(stage);
		await mkdir(destination);
		await writeFile(path.join(destination, screenshotNames[0]), 'approved');
		await expect(publishScreenshots(stage, destination)).rejects.toThrow();
		expect(await readFile(path.join(destination, screenshotNames[0]), 'utf8')).toBe('approved');
		await Promise.all(screenshotNames.map((name) => writeFile(path.join(stage, name), 'new capture')));
		await publishScreenshots(stage, destination);
		expect(await readFile(path.join(destination, screenshotNames[0]), 'utf8')).toBe('new capture');
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('labels review categories and supports older manifests', () => {
	expect(helpReviewLabel()).toBe('Needs review');
	expect(helpReviewLabel(['initial'])).toBe('Initial review required');
	expect(helpReviewLabel(['unknown'])).toBe('Unknown changes—full review required');
	expect(helpReviewLabel(['text'])).toBe('Text changed');
	expect(helpReviewLabel(['screenshots'])).toBe('Screenshots changed');
	expect(helpReviewLabel(['icons'])).toBe('Icons changed');
	expect(helpReviewLabel(['text', 'screenshots'])).toBe('Text and screenshots changed');
	expect(helpReviewLabel(['screenshots', 'icons'])).toBe('Visual assets changed');
	expect(helpReviewLabel(['text', 'screenshots', 'icons'])).toBe('Text and visual assets changed');
});
