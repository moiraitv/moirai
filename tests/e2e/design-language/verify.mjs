/* global document, window, getComputedStyle */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { serve, referenceRoot } from '../../../assets-src/design-language/scripts/serve.mjs';
import { catalogCardMinimumWidth, catalogCardColumnGap, catalogMobileBreakpoint, catalogColumnCount } from '../../../apps/web/src/catalog-virtualization.ts';
import { families, layouts } from '../../../assets-src/design-language/gallery/manifest.mjs';

let server;
let url;
let browser;
let page;
const faults = [];

before(async () => {
	({ server, url } = await serve());
	browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}) });
	page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'dark' });
	page.on('pageerror', error => faults.push(error.message));
	page.on('response', response => {
		if (response.status() >= 400) {
			faults.push(`${response.status()} ${response.url()}`);
		}
	});
	page.on('request', request => assert.equal(new URL(request.url()).origin, url, 'Reference must not request external assets'));
});

after(async () => {
	await browser?.close();
	await new Promise(resolve => server?.close(resolve));
});

async function visit(query = '') {
	await page.goto(`${url}/${query}`);
	await page.evaluate(async () => {
		await document.fonts.ready;
		await Promise.all([...document.images].map(image => image.decode()));
	});
}

async function markdownFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const results = await Promise.all(entries.map(entry => entry.isDirectory() ? markdownFiles(path.join(directory, entry.name)) : entry.name.endsWith('.md') ? [path.join(directory, entry.name)] : []));
	return results.flat();
}

function luminance(hex) {
	const channels = hex.match(/[\da-f]{2}/gi).map(channel => parseInt(channel, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(left, right) {
	const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
	return (values[0] + 0.05) / (values[1] + 0.05);
}

test('handbook coverage, local references and token table remain complete', async () => {
	for (const family of families) {
		await access(path.join(referenceRoot, `components/${family.id}.md`));
		await access(path.join(referenceRoot, `images/specimens/${family.id}.png`));
	}
	for (const file of await markdownFiles(referenceRoot)) {
		const text = await readFile(file, 'utf8');
		for (const [, target] of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
			if (/^(?:https?:|#)/.test(target)) {
				continue;
			}
			await access(path.resolve(path.dirname(file), target.split(/[?#]/)[0]));
		}
	}
	const css = await readFile(path.join(referenceRoot, 'tokens.css'), 'utf8');
	const table = await readFile(path.join(referenceRoot, 'docs/tokens.md'), 'utf8');
	const tokens = new Map([...css.matchAll(/(--[\w-]+): ([^;]+);/g)].map(([, key, value]) => [key, value]));
	const documented = new Map([...table.matchAll(/\|\s*`(--[\w-]+)`\s*\|\s*`([^`]+)`/g)].map(([, key, value]) => [key, value]));
	for (const [key, value] of tokens) {
		assert.equal(documented.get(key), value, `Token table: ${key}`);
	}
	for (const name of ['base', 'content', 'layouts']) {
		const source = await readFile(path.join(referenceRoot, `gallery/${name}.css`), 'utf8');
		for (const [, key] of source.matchAll(/var\((--[\w-]+)/g)) {
			assert.ok(tokens.has(key), `Undefined token: ${key}`);
		}
	}
});

test('semantic palette meets AA text contrast and essential boundary contrast', async () => {
	await visit();
	const color = await page.evaluate(() => Object.fromEntries([...getComputedStyle(document.documentElement)].filter(name => name.startsWith('--color-')).map(name => [name.slice(8), getComputedStyle(document.documentElement).getPropertyValue(name).trim()])));
	for (const text of ['text', 'secondary', 'muted']) {
		for (const surface of ['canvas', 'navigation', 'surface', 'raised', 'hover', 'selected']) {
			assert.ok(contrast(color[text], color[surface]) >= 4.5, `${text} on ${surface}`);
		}
	}
	for (const [text, surface] of [['info', 'info-surface'], ['danger', 'danger-surface'], ['warning', 'warning-surface'], ['purple', 'purple-surface'], ['success', 'selected'], ['on-accent', 'accent'], ['on-accent', 'accent-hover'], ['on-accent', 'accent-pressed']]) {
		assert.ok(contrast(color[text], color[surface]) >= 4.5, `${text} on ${surface}`);
	}
	for (const surface of ['canvas', 'surface', 'raised']) {
		assert.ok(contrast(color.control, color[surface]) >= 3, `Control boundary on ${surface}`);
		assert.ok(contrast(color.accent, color[surface]) >= 3, `Focus on ${surface}`);
	}
});

test('all rendered families and layouts load local Inter and images without page overflow', async () => {
	for (const family of families) {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await visit(`?family=${family.id}`);
		assert.equal(await page.locator('[data-board]').count(), 1);
		assert.equal(await page.evaluate(() => document.fonts.check('14px Inter')), true);
		assert.equal(await page.evaluate(() => [...document.fonts].some(font => font.family === 'Inter' && font.status === 'loaded')), true);
	}
	for (const layout of layouts) {
		await page.setViewportSize({ width: layout.width, height: layout.height });
		await visit(`?layout=${layout.id}`);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, layout.id);
	}
	assert.deepEqual(faults, []);
});

test('mobile and text-scaled editor preserve visible action bar with long draft values', async () => {
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await visit('?layout=mobile-editor');
		await page.getByLabel('Channel name', { exact: true }).fill('A channel with a very long authored name and preserved spelling');
		await page.locator('.editor-body').evaluate(element => {
			element.scrollTop = element.scrollHeight; 
		});
		const footer = await page.locator('.editor-footer').boundingBox();
		assert.ok(footer.y >= 0 && footer.y + footer.height <= 844);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
		for (const button of await page.locator('.editor-footer button').all()) {
			assert.ok((await button.boundingBox()).height >= 44);
		}
	}
	await page.setViewportSize({ width: 1440, height: 1000 });
	await visit('?layout=editor');
	await page.evaluate(() => {
		document.documentElement.style.fontSize = '200%'; 
	});
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	const footer = await page.locator('.editor-footer').boundingBox();
	assert.ok(footer.y + footer.height <= 1000);
});

test('keyboard focus, popover Escape, segmented state and reduced motion work', async () => {
	await visit('?family=actions');
	await page.getByRole('button', { name: 'Remove source', exact: true }).focus();
	assert.equal(await page.getByRole('button', { name: 'Remove source', exact: true }).evaluate(element => element.matches(':focus-visible')), true);
	await page.keyboard.press('Enter');
	assert.equal(await page.getByRole('button', { name: 'Confirm remove source' }).count(), 1);
	await page.keyboard.press('Escape');
	assert.equal(await page.getByRole('button', { name: 'Remove source', exact: true }).count(), 1);
	await visit('?family=choices');
	await page.getByRole('button', { name: 'Grid', exact: true }).click();
	assert.equal(await page.getByRole('button', { name: 'Grid', exact: true }).getAttribute('aria-pressed'), 'true');
	assert.equal(await page.getByRole('button', { name: 'List', exact: true }).getAttribute('aria-pressed'), 'false');
	await visit('?family=overlays');
	await page.getByRole('button', { name: 'Why unavailable?' }).focus();
	await expect(page.getByRole('tooltip')).toHaveCSS('opacity', '1');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('tooltip')).toHaveCSS('opacity', '0');
	await page.getByRole('button', { name: 'Open action list' }).click();
	assert.equal(await page.locator('#action-popover').evaluate(element => element.matches(':popover-open')), true);
	await page.keyboard.press('Escape');
	assert.equal(await page.locator('#action-popover').evaluate(element => element.matches(':popover-open')), false);
	await page.getByRole('button', { name: 'Open protected editor' }).click();
	assert.equal(await page.locator('#editor-dialog').evaluate(element => getComputedStyle(element).animationName), 'none');
	for (let index = 0; index < 16; index += 1) {
		await page.keyboard.press('Tab');
		// Native modal Tab wrapping can briefly focus the body sentinel, never background controls.
		assert.equal(await page.evaluate(() => document.activeElement === document.body || Boolean(document.activeElement.closest('#editor-dialog'))), true);
	}
	await page.keyboard.press('Escape');
	assert.equal(await page.getByRole('button', { name: 'Open protected editor' }).evaluate(element => element === document.activeElement), true);
});

test('editor protects dirty drafts, resets to latest saved baseline and confirms deletion', async () => {
	await visit('?family=overlays');
	await page.getByRole('button', { name: 'Open protected editor' }).click();
	const editor = page.locator('#editor-dialog');
	const name = editor.getByLabel('Channel name', { exact: true });
	const save = editor.getByRole('button', { name: 'Save', exact: true });
	const reset = editor.getByRole('button', { name: 'Reset', exact: true });
	assert.equal(await save.isDisabled(), true);
	assert.equal(await reset.isDisabled(), true);
	await name.fill('');
	assert.equal(await save.isDisabled(), true);
	assert.equal(await reset.isEnabled(), true);
	await name.fill('Changed channel');
	await page.keyboard.press('Escape');
	assert.equal(await page.locator('#confirm-dialog').isVisible(), true);
	await page.getByRole('button', { name: 'Keep editing' }).click();
	assert.equal(await name.inputValue(), 'Changed channel');
	await editor.getByRole('button', { name: 'Close channel editor' }).click();
	assert.equal(await page.locator('#confirm-dialog').isVisible(), true);
	await page.getByRole('button', { name: 'Keep editing' }).click();
	const bounds = await editor.boundingBox();
	await page.mouse.click(Math.max(2, bounds.x - 8), bounds.y + 24);
	assert.equal(await page.locator('#confirm-dialog').isVisible(), true);
	await page.getByRole('button', { name: 'Keep editing' }).click();
	await reset.click();
	assert.equal(await editor.getByRole('button', { name: 'Confirm reset channel draft' }).count(), 1);
	await page.keyboard.press('Escape');
	assert.equal(await editor.isVisible(), true);
	await reset.click();
	await editor.getByRole('button', { name: 'Confirm reset channel draft' }).click();
	assert.equal(await name.inputValue(), 'Night flight');
	assert.equal(await save.isDisabled(), true);
	await name.fill('Saved channel');
	await save.click();
	assert.equal(await save.isDisabled(), true);
	await name.fill('Another draft');
	await reset.click();
	await editor.getByRole('button', { name: 'Confirm reset channel draft' }).click();
	assert.equal(await name.inputValue(), 'Saved channel');
	await name.fill('');
	await editor.getByRole('button', { name: 'Delete channel', exact: true }).click();
	await page.locator('#confirm-dialog').getByRole('button', { name: 'Delete channel', exact: true }).click();
	assert.equal(await editor.isVisible(), false);
	assert.match(await page.getByRole('status').textContent(), /prototype only/);
});

test('two-step actions use checks, coordinate ownership and cancel without a modal', async () => {
	await visit('?family=actions');
	await page.clock.install();
	const remove = page.locator('[data-two-step]').filter({ hasText: 'Remove source' });
	const reset = page.locator('[data-two-step]').filter({ hasText: 'Reset draft' });
	await remove.click();
	const armed = page.getByRole('button', { name: 'Confirm remove source', exact: true });
	assert.equal(await armed.getAttribute('aria-pressed'), 'true');
	assert.equal(await armed.locator('svg').count(), 1);
	assert.equal((await armed.textContent()).trim(), '');
	assert.equal(await page.locator('dialog[open]').count(), 0);
	await page.keyboard.press('Tab');
	assert.equal(await remove.getAttribute('aria-pressed'), 'false');
	await remove.click();
	await page.getByRole('button', { name: 'Refresh preview' }).click();
	assert.equal(await remove.getAttribute('aria-pressed'), 'false');
	await remove.click();
	await page.clock.fastForward(5100);
	assert.equal(await remove.getAttribute('aria-pressed'), 'false');
	await remove.click();
	// Activation without a focus change also releases the previous confirmation owner.
	await reset.evaluate(button => button.click());
	assert.equal(await remove.getAttribute('aria-pressed'), 'false');
	const armedReset = page.getByRole('button', { name: 'Confirm reset draft', exact: true });
	assert.equal(await armedReset.getAttribute('aria-pressed'), 'true');
	assert.equal(await armedReset.locator('svg').count(), 1);
	await armedReset.click();
	assert.equal(await reset.getAttribute('aria-pressed'), 'false');
	assert.equal(await page.locator('dialog[open]').count(), 0);
	assert.match(await page.getByRole('status').textContent(), /confirmed/);
});

test('media tiles follow the public catalog sizing contract at desktop and mobile widths', async () => {
	for (const width of [1440, 390, 320, catalogMobileBreakpoint, catalogMobileBreakpoint + 1]) {
		await page.setViewportSize({ width, height: 1000 });
		await visit('?layout=library');
		const geometry = await page.locator('.cards').evaluate(element => {
			const style = getComputedStyle(element);
			const card = element.querySelector('.media-card');
			return { width: element.getBoundingClientRect().width, columns: style.gridTemplateColumns.split(' ').length, gap: parseFloat(style.columnGap), minimum: parseFloat(style.getPropertyValue('--media-card-min')), cardWidth: card.getBoundingClientRect().width };
		});
		assert.equal(geometry.minimum, catalogCardMinimumWidth);
		assert.equal(geometry.gap, catalogCardColumnGap);
		assert.equal(geometry.columns, catalogColumnCount(geometry.width, width));
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
		if (width > catalogMobileBreakpoint) {
			assert.ok(geometry.cardWidth >= catalogCardMinimumWidth);
		}
	}
});

test('footers align vertically, utility icons have no bezel and segments form one compact track', async () => {
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		for (const family of ['collections', 'media']) {
			await visit(`?family=${family}`);
			const deltas = await page.locator(family === 'collections' ? '.pagination > .row' : '[data-board] > .stack > .row').evaluate(element => {
				const children = [...element.children].slice(0, 2);
				const centers = children.map(child => {
					const rect = child.getBoundingClientRect();
					return rect.y + rect.height / 2;
				});
				return Math.abs(centers[0] - centers[1]);
			});
			assert.ok(deltas <= 1, `${family} at ${width}px`);
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${family} overflow at ${width}px`);
		}
		await visit('?family=choices');
		const track = await page.locator('.segment').boundingBox();
		const list = await page.getByRole('button', { name: 'List', exact: true }).boundingBox();
		const grid = await page.getByRole('button', { name: 'Grid', exact: true }).boundingBox();
		assert.ok(Math.abs(list.width - grid.width) <= 1);
		assert.ok(Math.abs(list.x + list.width - grid.x) <= 1);
		assert.ok(track.width < 220);
		if (width <= 600) {
			assert.ok(list.height >= 44 && grid.height >= 44);
		}
	}
	await visit('?family=actions');
	await page.mouse.move(0, 0);
	await expect(page.getByRole('button', { name: 'Refresh preview' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await expect(page.getByRole('button', { name: 'Refresh preview' })).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
});

test('context actions use adjacent menu rows and return focus on Escape or selection', async () => {
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		await visit('?family=overlays');
		const trigger = page.getByRole('button', { name: 'Open action list' });
		await trigger.click();
		const popup = page.locator('#action-popover');
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
		assert.equal(await popup.locator('hr').count(), 1);
		for (const row of await popup.getByRole('button').all()) {
			await expect(row).toHaveCSS('border-top-width', '0px');
			if (width <= 600) {
				assert.ok((await row.boundingBox()).height >= 44);
			}
		}
		const box = await popup.boundingBox();
		assert.ok(box.x >= 0 && box.x + box.width <= width);
		await page.keyboard.press('Escape');
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
		await expect(trigger).toBeFocused();
		await trigger.click();
		await popup.getByRole('button', { name: 'Duplicate', exact: true }).click();
		await expect(trigger).toBeFocused();
		assert.equal(await popup.evaluate(element => element.matches(':popover-open')), false);
		await trigger.click();
		await page.getByRole('button', { name: 'Open protected editor' }).click();
		assert.equal(await popup.evaluate(element => element.matches(':popover-open')), false);
		await page.keyboard.press('Escape');
	}
});

test('success toast can be dismissed and automatically expires', async () => {
	await visit('?family=feedback');
	await page.clock.install();
	await page.getByRole('button', { name: 'Show live toast' }).click();
	await page.locator('.toast-region').getByRole('button', { name: 'Dismiss notification' }).click();
	assert.equal(await page.locator('.toast-region .toast').count(), 0);
	await page.getByRole('button', { name: 'Show live toast' }).click();
	await page.locator('.toast-region .toast').hover();
	await page.clock.fastForward(8100);
	assert.equal(await page.locator('.toast-region .toast').count(), 1);
	await page.mouse.move(0, 0);
	await page.clock.fastForward(8100);
	assert.equal(await page.locator('.toast-region .toast').count(), 0);
	await page.getByRole('button', { name: 'Show live toast' }).click();
	await page.clock.fastForward(5000);
	await page.getByRole('button', { name: 'Show live toast' }).click();
	await page.clock.fastForward(4000);
	assert.equal(await page.locator('.toast-region .toast').count(), 1);
	await page.clock.fastForward(4100);
	assert.equal(await page.locator('.toast-region .toast').count(), 0);
});

test('settings tabs retain drafts, expose dirty state and support keyboard navigation', async () => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await visit('?layout=settings');
	const playback = page.getByRole('tab', { name: /^Playback/ });
	await page.getByLabel('Maximum active channel sessions').fill('6');
	await expect(playback.locator('[data-dirty]')).toBeVisible();
	await playback.focus();
	await page.keyboard.press('ArrowRight');
	await expect(page.getByRole('tab', { name: /^AI/ })).toBeFocused();
	await expect(page.getByRole('tabpanel', { name: /^AI/ })).toBeVisible();
	await expect(page.getByRole('tab', { name: /^AI/ })).toHaveAccessibleName(/Needs attention/);
	await expect(page.getByRole('status')).toContainText('connection needs attention');
	await page.keyboard.press('End');
	await expect(page.getByRole('tab', { name: 'Backups' })).toBeFocused();
	await page.getByRole('button', { name: 'Automatic Backup', exact: true }).click();
	await expect(page.getByLabel('Backup interval (days)')).toBeVisible();
	await page.getByRole('tab', { name: 'Backups' }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(playback).toBeFocused();
	await expect(page.getByLabel('Maximum active channel sessions')).toHaveValue('6');
	await page.getByRole('button', { name: 'Save Playback Settings', exact: true }).click();
	await expect(playback.locator('[data-dirty]')).toBeHidden();
	await page.getByLabel('Maximum active channel sessions').fill('8');
	await page.getByRole('button', { name: 'Reset Playback settings draft', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm Reset Playback settings draft', exact: true }).click();
	await expect(page.getByLabel('Maximum active channel sessions')).toHaveValue('6');
	for (const width of [320, 390]) {
		await page.setViewportSize({ width, height: 844 });
		await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	}
});
