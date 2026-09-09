import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page, type Locator } from '@playwright/test';
import { PROGRAM_COLOR_PALETTE } from '../../../apps/web/src/program-colors';

/** Per-scene identity map; colors do not depend on backend-generated UUIDs. */
const programColors = new WeakMap<Page, Record<string, typeof PROGRAM_COLOR_PALETTE[number]>>();
/** Keep repeat runs separate so their pixels can be compared without overwriting evidence. */
const captureDirectories = new WeakMap<Page, string>();

/** Select the disposable output directory for a capture repetition. */
export function registerCaptureDirectory(page: Page, repeatIndex: number): void {
	captureDirectories.set(page, path.resolve('test-results/docs-screenshots', ...(repeatIndex ? [`repeat-${repeatIndex}`] : [])));
}

/** Assign distinct shared palette colors in authored fixture order. */
export function registerProgramColors(page: Page, ids: string[]): void {
	programColors.set(page, Object.fromEntries(ids.map((id, index) => [id, PROGRAM_COLOR_PALETTE[index]!])));
}

/** Wait for actual content and loaded pixels, then apply only capture-specific presentation. */
async function prepare(page: Page): Promise<void> {
	const colorRules = Object.entries(programColors.get(page) ?? {}).map(([id, color]) => {
		const declarations = Object.entries(color).map(([suffix, value]) =>
			`${suffix === 'solid' ? '--program-color' : `--program-color-${suffix}`}:${value}!important`).join(';');
		return `[data-program-id="${id}"]{${declarations}}`;
	}).join('\n');
	if (colorRules) {
		await page.addStyleTag({ content: colorRules });
	}
	await expect(page.locator('.resolved-preview-loading')).toHaveCount(0);
	await page.evaluate(() => {
		for (const video of document.querySelectorAll('video')) {
			video.preload = 'auto';
			video.pause();
			if (video.currentTime !== 0.001) {
				video.currentTime = 0.001;
			}
		}
	});
	await expect.poll(() => page.evaluate(() => Array.from(document.querySelectorAll('video'))
		.every((video) => video.readyState === 4 && video.networkState === 1 && !video.seeking)), { timeout: 15_000 }).toBe(true);
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
	// Load authored image sources even when carousel clipping keeps lazy images deferred.
	await page.evaluate(() => {
		for (const image of document.images) {
			image.loading = 'eager';
		}
	});
	await expect.poll(() => page.evaluate(() => Array.from(document.images)
		.filter((image) => Boolean(image.getAttribute('src')) && (!image.complete || !image.naturalWidth))
		.map((image) => image.getAttribute('src'))), { timeout: 15_000 }).toEqual([]);
	await expect.poll(() => page.evaluate(() => document.getAnimations().filter((animation) =>
		animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	await page.evaluate(() => {
		document.querySelector('.public-url-warning')?.remove();
		document.querySelector('.epg-feed-card .notice.warning')?.remove();
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) {
			const original = walker.currentNode.textContent ?? '';
			const sanitized = original.replace(/[^\s<>"']*\/test-results\/documentation-runtime\/scene-[^\s<>"']*/gu, '/media/movies');
			if (sanitized !== original) {
				walker.currentNode.textContent = sanitized;
			}
		}
	});
}

/** Capture the completed viewport into disposable staging, never directly into the guide. */
export async function capture(page: Page, name: string): Promise<void> {
	await prepare(page);
	const directory = captureDirectories.get(page)!;
	await mkdir(directory, { recursive: true });
	await page.screenshot({ path: path.join(directory, name), animations: 'disabled' });
}

/** Capture a semantically selected, fully loaded editor region. */
export async function captureSection(page: Page, section: Locator, name: string): Promise<void> {
	await section.scrollIntoViewIfNeeded();
	await prepare(page);
	await section.screenshot({ path: path.join(captureDirectories.get(page)!, name), animations: 'disabled' });
}

/** Verify distinct fixture identities across real timeline, legend, and preview elements. */
export async function assertProgramColors(page: Page, ids: string[]): Promise<void> {
	const colors = programColors.get(page)!;
	expect(new Set(ids.map((id) => colors[id]!.solid)).size).toBe(ids.length);
	for (const id of ids) {
		for (const region of ['.template-slot', '.template-program-legend > span', '.resolved-segment.role-primary']) {
			const elements = page.locator(`${region}[data-program-id="${id}"]`);
			await expect(elements.first()).toBeVisible();
			const actual = await elements.evaluateAll((nodes) => nodes.map((node) =>
				getComputedStyle(node).getPropertyValue('--program-color').trim()));
			expect(actual.every((color) => color === colors[id]!.solid)).toBe(true);
		}
	}
}
