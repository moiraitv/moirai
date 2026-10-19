/* global document, window */
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { serve, referenceRoot } from './serve.mjs';
import { families, layouts } from '../gallery/manifest.mjs';

/** Compare screenshot bytes without modifying the reference when --check is supplied. */
const check = process.argv.includes('--check');
/** Isolated browser and loopback server need no application build or fixture database. */
const { server, url } = await serve();
/** Use the installed Playwright browser unless a local Chromium is explicitly selected. */
const browser = await chromium.launch({ args: ['--disable-gpu'], ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}) });
/** Capture metadata for reproducing this edition with the same font and browser. */
const captures = [];

/** Wait for local fonts and images before measuring or taking a screenshot. */
async function ready(page) {
	await page.evaluate(async () => {
		await document.fonts.ready;
		await Promise.all([...document.images].map(image => image.decode()));
	});
}

/** Save or compare one PNG and record a stable digest of its rendered bytes. */
async function capture(page, filename, board = false, fullPage = false) {
	// Let focus and sticky positioning settle after navigation or viewport changes.
	await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
	const buffer = board ? await page.locator('[data-board]').screenshot({ animations: 'disabled' }) : await page.screenshot({ animations: 'disabled', fullPage });
	const target = path.join(referenceRoot, 'images', filename);
	if (check) {
		const previous = await readFile(target);
		if (!buffer.equals(previous)) {
			const diagnostic = path.resolve('test-results/design-language', path.basename(filename));
			await mkdir(path.dirname(diagnostic), { recursive: true });
			await writeFile(diagnostic, buffer);
			throw new Error(`Capture differs: ${filename}. Actual image: ${diagnostic}`);
		}
	}
	else {
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, buffer);
	}
	captures.push({ file: filename, sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length });
	console.log(`${check ? 'Verified' : 'Captured'} ${filename}`);
}

/** Expand only the canvas height so persistent collection or Settings actions sit below all content. */
async function expandedCanvas(page, filename) {
	const viewport = page.viewportSize();
	const height = await page.evaluate(() => document.documentElement.scrollHeight);
	await page.setViewportSize({ width: viewport.width, height });
	await capture(page, filename);
	await page.setViewportSize(viewport);
}

try {
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce', colorScheme: 'dark' });
	await page.goto(url);
	await ready(page);
	await capture(page, 'index.png', false, true);
	for (const family of families) {
		await page.goto(`${url}/?family=${family.id}`);
		await ready(page);
		await capture(page, `specimens/${family.id}.png`, true);
	}
	// Capture presentation states that cannot be seen on a resting specimen board.
	await page.goto(`${url}/?family=overlays`);
	await ready(page);
	await page.getByRole('button', { name: 'Why unavailable?' }).focus();
	await capture(page, 'specimens/tooltip-open.png', true);
	await page.getByRole('button', { name: 'Open action list' }).click();
	await capture(page, 'specimens/popover-open.png');
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Open help drawer' }).click();
	await page.locator('#help-topic-title').waitFor();
	await ready(page);
	await capture(page, 'specimens/drawer-open.png');
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Show loading help example' }).click();
	await capture(page, 'specimens/help-loading.png');
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Show failed help example' }).click();
	await capture(page, 'specimens/help-failed.png');
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Open protected editor' }).click();
	await page.getByLabel('Name', { exact: true }).fill('Night flight · revised');
	await page.keyboard.press('Escape');
	await ready(page);
	await capture(page, 'specimens/discard-confirmation.png');
	await page.getByRole('button', { name: 'Keep editing' }).click();
	await page.locator('#editor-dialog').getByRole('button', { name: 'Delete Channel', exact: true }).click();
	await ready(page);
	await capture(page, 'specimens/delete-confirmation.png');

	// Narrow reference boards keep the refined relationships visible during iteration.
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		for (const id of ['actions', 'choices', 'collections', 'media', 'overlays', 'programs']) {
			await page.goto(`${url}/?family=${id}`);
			await ready(page);
			await capture(page, `specimens/${id}-${width}.png`, true);
		}
		for (const id of ['guide', 'program-editor']) {
			await page.goto(`${url}/?layout=${id}`);
			await ready(page);
			await capture(page, `layouts/${id}-${width}.png`);
			if (id === 'program-editor') {
				await page.locator('.editor-body').evaluate(element => {
					element.scrollTop = element.scrollHeight; 
				});
				await capture(page, `layouts/${id}-${width}-scrolled.png`);
			}
		}
		await page.goto(`${url}/?layout=mobile-catalog`);
		await ready(page);
		await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
		await capture(page, `layouts/navigation-${width}.png`);
		await page.keyboard.press('Escape');
		await page.locator('.current-program-identity').first().click();
		await ready(page);
		await capture(page, `layouts/inspector-${width}.png`);
		await page.keyboard.press('Escape');
		await page.goto(`${url}/?layout=library`);
		await ready(page);
		await capture(page, `layouts/library-${width}.png`);
		await expandedCanvas(page, `layouts/library-${width}-expanded.png`);
		await page.getByRole('button', { name: 'Select items', exact: true }).click();
		await page.locator('.media-select').first().click();
		await page.evaluate(() => window.scrollTo(0, 0));
		await capture(page, `layouts/library-bulk-${width}.png`);
		await expandedCanvas(page, `layouts/library-bulk-${width}-expanded.png`);
	}

	for (const layout of layouts) {
		await page.setViewportSize({ width: layout.width, height: layout.height });
		await page.goto(`${url}/?layout=${layout.id}`);
		await ready(page);
		await capture(page, `layouts/${layout.id}.png`);
		if (['catalog', 'editor'].includes(layout.id)) {
			// Compare radius values on the same source-backed composition, not an older layout.
			const trial = page.locator('link[href="./gallery/radius-trial.css"]');
			await trial.evaluate(link => {
				link.disabled = true; 
			});
			await capture(page, `../experiments/radius-50/${layout.id}-before.png`);
			await trial.evaluate(link => {
				link.disabled = false; 
			});
		}
		if (await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)) {
			if (layout.id === 'library') {
				await expandedCanvas(page, `layouts/${layout.id}-expanded.png`);
			}
			else {
				await capture(page, `layouts/${layout.id}-expanded.png`, false, true);
			}
		}
		if (layout.id === 'guide') {
			await page.locator('[data-guide-slot]').first().click();
			await ready(page);
			await capture(page, 'layouts/guide-detail-open.png');
			await page.keyboard.press('Escape');
		}
		if (layout.id === 'catalog') {
			await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Settings', exact: true }).hover();
			await capture(page, 'layouts/catalog-navigation-hover.png');
			await page.mouse.move(1400, 950);
		}
		if (layout.id === 'library') {
			await page.getByRole('button', { name: 'Help with Libraries', exact: true }).click();
			await page.locator('#help-topic-title').waitFor();
			await ready(page);
			await capture(page, 'layouts/library-help.png');
			await page.keyboard.press('Escape');
			await page.getByRole('button', { name: 'Last scan: open scan history', exact: true }).click();
			await capture(page, 'layouts/library-scan-history.png');
			await page.keyboard.press('Escape');
			await page.getByRole('button', { name: 'Filter media', exact: true }).click();
			await capture(page, 'layouts/library-filter-open.png');
			await page.keyboard.press('Escape');
			await page.locator('[data-library-sort]').click();
			await capture(page, 'layouts/library-sort-open.png');
			await page.keyboard.press('Escape');
			await page.getByRole('button', { name: 'Select items', exact: true }).click();
			await page.locator('.media-select').first().click();
			await page.evaluate(() => window.scrollTo(0, 0));
			await capture(page, 'layouts/library-bulk.png');
		}
		if (layout.id === 'settings') {
			await page.getByRole('button', { name: 'Engine details', exact: true }).click();
			await capture(page, 'layouts/settings-engine-open.png');
			await page.keyboard.press('Escape');
			for (const section of ['AI', 'Backups']) {
				await page.getByRole('tab', { name: new RegExp(`^${section}`) }).click();
				await capture(page, `layouts/settings-${section.toLowerCase()}.png`);
			}
			await page.getByRole('tab', { name: 'Playback', exact: true }).click();
			await page.getByText('Break budget warnings', { exact: false }).click();
			await capture(page, 'layouts/settings-disclosure.png');
			for (const width of [390, 320]) {
				await page.setViewportSize({ width, height: 844 });
				await capture(page, `layouts/settings-${width}.png`);
				await expandedCanvas(page, `layouts/settings-${width}-expanded.png`);
			}
			await page.setViewportSize({ width: layout.width, height: layout.height });
		}
		if (layout.id.includes('editor')) {
			await page.locator('.editor-body').evaluate(element => {
				element.scrollTop = element.scrollHeight; 
			});
			await capture(page, `layouts/${layout.id}-scrolled.png`);
		}
	}
	if (!check) {
		const font = await readFile(path.join(referenceRoot, 'assets/fonts/InterVariable.woff2'));
		await writeFile(path.join(referenceRoot, 'images/captures.json'), `${JSON.stringify({ browser: browser.version(), launchArgs: ['--disable-gpu'], scale: 1, locale: 'en-US', timezone: 'America/Los_Angeles', motion: 'reduce', fontSha256: createHash('sha256').update(font).digest('hex'), captures }, null, 2)}\n`);
	}
}
finally {
	await browser.close();
	await new Promise(resolve => server.close(resolve));
}
