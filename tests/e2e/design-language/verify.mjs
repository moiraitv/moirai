/* global document, window, getComputedStyle */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { serve, referenceRoot } from '../../../docs/design-language/scripts/serve.mjs';
import { catalogCardMinimumWidth, catalogCardColumnGap, catalogMobileBreakpoint, catalogColumnCount } from '../../../apps/web/src/catalog-virtualization.ts';
import { families, layouts } from '../../../docs/design-language/gallery/manifest.mjs';

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
	for (const name of ['base', 'content', 'layouts', 'current-ui', 'surfaces', 'library', 'audit', 'help', 'corrections']) {
		const source = await readFile(path.join(referenceRoot, `gallery/${name}.css`), 'utf8');
		const declared = new Set([...tokens.keys(), ...[...source.matchAll(/(--[\w-]+)\s*:/g)].map(([, key]) => key)]);
		for (const [, key] of source.matchAll(/var\((--[\w-]+)/g)) {
			assert.ok(declared.has(key), `Undefined token: ${key}`);
		}
	}
});

test('semantic palette meets AA text contrast and essential boundary contrast', async () => {
	await visit();
	const color = await page.evaluate(() => Object.fromEntries([...getComputedStyle(document.documentElement)].filter(name => name.startsWith('--color-')).map(name => [name.slice(8), getComputedStyle(document.documentElement).getPropertyValue(name).trim()])));
	// Check both endpoints of every finish against the same semantic pairings.
	const finishes = await page.evaluate(() => ['--canvas-gradient', '--surface-gradient', '--field-gradient', '--button-surface-gradient'].map(name => [name, getComputedStyle(document.documentElement).getPropertyValue(name)]));
	const stops = finishes.flatMap(([name, finish]) => [...finish.matchAll(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)%\)/g)].map(([, r, g, b, opacity]) => ({ name, channels: [r, g, b].map(Number), opacity: Number(opacity) / 100 })));
	assert.equal(stops.length, finishes.length * 2);
	const backgrounds = (base, action = false) => [base, ...stops.filter(stop => action || stop.name !== '--button-surface-gradient').map(stop => `#${base.match(/[\da-f]{2}/gi).map((channel, index) => Math.round(parseInt(channel, 16) * (1 - stop.opacity) + stop.channels[index] * stop.opacity).toString(16).padStart(2, '0')).join('')}`)];
	for (const text of ['text', 'secondary', 'muted']) {
		for (const surface of ['canvas', 'navigation', 'surface', 'raised', 'hover', 'selected']) {
			for (const background of backgrounds(color[surface])) {
				assert.ok(contrast(color[text], background) >= 4.5, `${text} on ${surface} / ${background}`);
			}
		}
	}
	for (const [text, surface] of [['info', 'info-surface'], ['danger', 'danger-surface'], ['warning', 'warning-surface'], ['purple', 'purple-surface'], ['success', 'selected'], ['on-accent', 'accent'], ['on-accent', 'accent-hover'], ['on-accent', 'accent-pressed'], ['on-primary', 'primary'], ['on-primary', 'primary-hover'], ['on-primary', 'primary-pressed']]) {
		for (const background of backgrounds(color[surface], true)) {
			assert.ok(contrast(color[text], background) >= 4.5, `${text} on ${surface} / ${background}`);
		}
	}
	for (const surface of ['canvas', 'surface', 'raised']) {
		for (const background of backgrounds(color[surface])) {
			assert.ok(contrast(color.control, background) >= 3, `Control boundary on ${surface}`);
			assert.ok(contrast(color.accent, background) >= 3, `Focus on ${surface}`);
		}
	}
	await visit('?family=actions');
	const primary = page.locator('button.primary').first();
	await page.mouse.move(1400, 950);
	for (const state of ['primary', 'primary-hover', 'primary-pressed']) {
		if (state === 'primary-hover') {
			await primary.hover();
		}
		if (state === 'primary-pressed') {
			await page.mouse.down();
		}
		await expect(primary).toHaveCSS('color', 'rgb(255, 255, 255)');
		await expect(primary).toHaveCSS('background-color', `rgb(${color[state].match(/[\da-f]{2}/gi).map(value => parseInt(value, 16)).join(', ')})`);
	}
	await page.mouse.move(1400, 950);
	await page.mouse.up();
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
		await page.getByLabel('Name', { exact: true }).fill('A channel with a very long authored name and preserved spelling');
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
	const name = editor.getByLabel('Name', { exact: true });
	const save = editor.locator('[data-save]');
	const reset = editor.getByRole('button', { name: 'Reset', exact: true });
	assert.equal(await save.textContent(), 'Close');
	assert.equal(await save.isEnabled(), true);
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
	assert.equal(await reset.locator('.action-glyph').count(), 0);
	assert.equal(await save.locator('.action-glyph').count(), 0);
	assert.equal(await save.textContent(), 'Close');
	await name.fill('Saved channel');
	assert.equal(await save.locator('.action-save[aria-hidden="true"]').count(), 1);
	await save.locator('.action-glyph').click();
	assert.equal(await save.textContent(), 'Close');
	await name.fill('Another draft');
	await reset.click();
	await editor.getByRole('button', { name: 'Confirm reset channel draft' }).click();
	assert.equal(await name.inputValue(), 'Saved channel');
	await name.fill('');
	await editor.getByRole('button', { name: 'Delete Channel', exact: true }).click();
	await page.locator('#confirm-dialog').getByRole('button', { name: 'Delete Channel', exact: true }).click();
	assert.equal(await editor.isVisible(), false);
	assert.match(await page.getByRole('status').textContent(), /prototype only/);
});

test('current UI compositions preserve source-owned controls, tight titles and the permanent corner scale', async () => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await visit('?layout=catalog');
	const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
	const settings = navigation.getByRole('link', { name: 'Settings', exact: true });
	await page.mouse.move(1400, 950);
	await expect(settings).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await settings.hover();
	await expect(settings).toHaveCSS('background-color', 'rgb(22, 45, 61)');
	const group = navigation.locator('.current-nav-heading').filter({ hasText: 'Libraries' }).getByRole('link');
	await group.hover();
	await expect(group).toHaveCSS('background-color', 'rgb(22, 45, 61)');
	await expect(settings).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	const current = navigation.getByRole('link', { name: 'Programs', exact: true });
	await current.hover();
	await expect(current).toHaveAttribute('aria-current', 'page');
	await expect(current).toHaveCSS('background-color', 'rgb(16, 60, 54)');
	await settings.focus();
	assert.equal(await settings.evaluate(element => element.matches(':focus-visible')), true);
	await page.mouse.move(1400, 950);
	assert.equal(await page.getByLabel('Filter Content definition').count(), 1);
	assert.equal(await page.getByLabel('Filter program usage').count(), 1);
	assert.equal(await page.getByRole('listitem').count(), 8);
	assert.equal(await page.getByText('Program / Definition', { exact: true }).count(), 1);
	assert.equal(await page.locator('.pagination').count(), 0);
	await visit('?layout=schedules');
	assert.equal(await page.getByRole('heading', { name: 'Channel Schedules', exact: true }).count(), 1);
	assert.equal(await page.locator('.current-schedule-card').count(), 3);
	assert.equal(await page.locator('.timeline').count(), 0);
	await visit('?layout=editor');
	assert.equal(await page.getByLabel('Group', { exact: true }).count(), 1);
	assert.equal(await page.getByLabel('Guide title', { exact: true }).count(), 0);
	assert.equal(await page.getByLabel('Description', { exact: true }).count(), 0);
	assert.equal(await page.locator('[data-save]').textContent(), 'Close');
	await visit('?layout=settings');
	const gap = await page.locator('.settings-card-heading').first().evaluate(header => {
		const title = header.querySelector('h3').getBoundingClientRect();
		const subtitle = header.querySelector('p').getBoundingClientRect();
		return subtitle.top - title.bottom;
	});
	assert.ok(gap >= 0 && gap <= 3, `Title/subtitle gap: ${gap}`);
	const radius = await page.locator('[data-settings-section]').first().evaluate(element => getComputedStyle(element).borderTopLeftRadius);
	assert.equal(radius, '6px');
});

test('two-step actions use checks, coordinate ownership and cancel without a modal', async () => {
	await visit('?family=actions');
	await page.clock.install();
	const remove = page.locator('[data-remove-source]').first();
	const reset = page.locator('[data-two-step]').filter({ hasText: 'Reset draft' });
	await remove.click();
	const armed = page.getByRole('button', { name: 'Confirm remove source', exact: true });
	assert.equal(await armed.getAttribute('aria-pressed'), 'true');
	assert.equal(await armed.locator('svg').count(), 1);
	assert.equal((await armed.innerText()).trim(), '');
	const appearance = await armed.evaluate(element => {
		const style = getComputedStyle(element);
		return { border: style.borderColor, background: style.backgroundColor, image: style.backgroundImage };
	});
	assert.notEqual(appearance.border, 'rgba(0, 0, 0, 0)');
	assert.notEqual(appearance.background, 'rgba(0, 0, 0, 0)');
	assert.match(appearance.image, /linear-gradient/);
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
			const deltas = await page.locator(family === 'collections' ? '.current-library-pagination' : '[data-media-bulk]:not([hidden])').evaluate(element => {
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
		await expect(popup.getByRole('link', { name: 'Edit Program' })).toHaveAttribute('href', '?layout=program-editor');
		await popup.getByRole('button', { name: 'Delete Program', exact: true }).click();
		await expect(page.locator('#confirm-dialog')).toBeVisible();
		await page.locator('#confirm-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
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
	await expect(page.getByText('AI is off. Saving a provider enables it.', { exact: true })).toBeVisible();
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

test('detailed choices explain significant options and preserve exclusive keyboard selection', async () => {
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
		await visit('?family=choices');
		const group = page.getByRole('group', { name: 'Selection strategy', exact: true });
		assert.equal(await group.getByRole('button', { pressed: true }).count(), 1);
		const random = group.getByRole('button', { name: 'Random', exact: true });
		await random.click();
		assert.equal(await random.getAttribute('aria-pressed'), 'true');
		assert.equal(await group.getByRole('button', { pressed: true }).count(), 1);
		assert.equal(await random.getAttribute('aria-describedby'), await random.locator('.choice-detail').getAttribute('id'));
		const sequential = group.getByRole('button', { name: 'Sequential', exact: true });
		await sequential.focus();
		await page.keyboard.press('Space');
		assert.equal(await sequential.getAttribute('aria-pressed'), 'true');
		await expect(sequential).toBeFocused();
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
		for (const card of await group.getByRole('button').all()) {
			assert.ok((await card.boundingBox()).height >= 170);
			assert.equal(await card.evaluate(element => element.scrollWidth <= element.clientWidth), true);
		}
	}
	await visit('?family=programs');
	const ordering = page.getByRole('group', { name: 'Sequence ordering', exact: true });
	await ordering.getByRole('button', { name: 'Balanced rotation', exact: true }).click();
	assert.equal(await ordering.getByRole('button', { pressed: true }).count(), 1);
	assert.equal(await ordering.getByRole('button', { name: 'Balanced rotation', pressed: true }).count(), 1);
});

test('arming two-step actions preserves their bounds, shape and neighboring controls', async () => {
	const geometry = button => button.evaluate(element => {
		const box = element.getBoundingClientRect();
		const next = element.nextElementSibling?.getBoundingClientRect();
		return { x: box.x, y: box.y, width: box.width, height: box.height, radius: getComputedStyle(element).borderRadius, next: next ? { x: next.x, y: next.y, width: next.width, height: next.height } : null };
	});
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		await visit('?family=actions');
		for (const button of await page.locator('[data-two-step]').all()) {
			await button.scrollIntoViewIfNeeded();
			const before = await geometry(button);
			await button.click();
			assert.deepEqual(await geometry(button), before);
			await page.keyboard.press('Escape');
			assert.deepEqual(await geometry(button), before);
		}
		await visit('?layout=settings');
		await page.getByLabel('Maximum active channel sessions').fill('8');
		const reset = page.locator('#playback-panel [data-settings-reset]');
		await reset.scrollIntoViewIfNeeded();
		const before = await geometry(reset);
		await reset.click();
		assert.deepEqual(await geometry(reset), before);
		assert.equal(await reset.getAttribute('aria-label'), 'Confirm Reset Playback settings draft');
		assert.equal(await reset.innerText(), '');
		await page.keyboard.press('Escape');
		assert.deepEqual(await geometry(reset), before);
		await visit('?family=programs');
		const remove = page.locator('[data-remove-source]').first();
		await remove.scrollIntoViewIfNeeded();
		const sourceBefore = await geometry(remove);
		const row = await remove.locator('..').boundingBox();
		assert.ok(Math.abs(sourceBefore.y + sourceBefore.height / 2 - row.y - row.height / 2) <= 0.5);
		await remove.click();
		assert.deepEqual(await geometry(remove), sourceBefore);
		await page.keyboard.press('Escape');
		assert.deepEqual(await geometry(remove), sourceBefore);
	}
});

test('compact media carousels scroll locally and preserve distinct asynchronous states', async () => {
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		await visit('?family=media');
		const strip = page.getByRole('region', { name: 'Compact media preview carousel', exact: true });
		const sizing = await strip.evaluate(element => {
			const card = element.querySelector('.preview-card');
			const style = getComputedStyle(element);
			return { overflows: element.scrollWidth > element.clientWidth, card: card.getBoundingClientRect().width, expected: parseFloat(style.getPropertyValue('--preview-card-width')), gap: parseFloat(style.gap), expectedGap: parseFloat(style.getPropertyValue('--preview-card-gap')) };
		});
		assert.equal(sizing.overflows, true);
		assert.equal(sizing.card, sizing.expected);
		assert.equal(sizing.gap, sizing.expectedGap);
		await strip.focus();
		await page.keyboard.press('ArrowRight');
		await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
		const last = strip.getByRole('link').last();
		await last.focus();
		const bounds = await strip.boundingBox();
		const item = await last.boundingBox();
		assert.ok(item.x >= bounds.x && item.x + item.width <= bounds.x + bounds.width + 1);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
		assert.equal(await page.locator('[data-preview-state="loading"] [aria-busy="true"]').count(), 1);
		assert.equal(await page.locator('[data-preview-state="empty"]').getByRole('status').count(), 1);
		assert.equal(await page.locator('[data-preview-state="failed"]').getByRole('alert').count(), 1);
		assert.equal(await page.locator('[data-preview-state]:not([data-preview-state="populated"]) .media-carousel[inert][aria-hidden="true"]').count(), 3);
	}
	await page.setViewportSize({ width: 1440, height: 1000 });
	await visit('?layout=catalog');
	const inspector = page.getByRole('region', { name: 'Media preview carousel', exact: true });
	const artwork = await inspector.locator('.poster').first().boundingBox();
	assert.ok(Math.abs(artwork.width / artwork.height - 2 / 3) < 0.01);
	assert.equal(await inspector.evaluate(element => element.scrollWidth > element.clientWidth), true);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
});

test('library preserves single-item add and explicit full-card bulk selection', async () => {
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await visit('?layout=library');
		await expect(page.locator('.media-add:visible')).toHaveCount(8);
		await expect(page.locator('.media-select:visible')).toHaveCount(0);
		await expect(page.locator('[data-media-bulk]')).toBeHidden();
		await page.locator('.media-add').first().click();
		const destination = page.getByRole('dialog', { name: 'Add to Program', exact: true });
		await expect(destination).toBeVisible();
		await expect(destination).toContainText('Afterlight Station');
		await page.keyboard.press('Escape');
		await expect(page.locator('.media-add').first()).toBeFocused();
		await page.getByRole('button', { name: 'Select items', exact: true }).click();
		await expect(page.locator('.media-add:visible')).toHaveCount(0);
		await expect(page.locator('.media-select:visible')).toHaveCount(8);
		await expect(page.locator('[data-media-count]')).toHaveText('0 selected');
		await expect(page.locator('[data-media-add-selected]')).toBeDisabled();
		const select = page.locator('.media-select').first();
		await select.focus();
		await page.keyboard.press('Space');
		await expect(select).toHaveAttribute('aria-pressed', 'true');
		await expect(select).toHaveAccessibleName('Deselect Afterlight Station');
		await expect(page.locator('.media-card.selected')).toHaveCount(1);
		await expect(page.locator('[data-media-count]')).toHaveText('1 selected');
		await page.locator('[data-media-add-selected]').click();
		await expect(destination).toContainText('1 selected');
		await page.keyboard.press('Escape');
		await select.click({ position: { x: 20, y: 100 } });
		await expect(select).toHaveAttribute('aria-pressed', 'false');
		await page.getByRole('button', { name: 'Cancel selection', exact: true }).click();
		await expect(page.locator('.media-add:visible')).toHaveCount(8);
		await expect(page.locator('[data-media-bulk]')).toBeHidden();
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	}
});

test('source-shaped library controls, status disclosure and page help remain present', async () => {
	for (const [layout, label] of [['catalog', 'Programs'], ['mobile-catalog', 'Programs'], ['library', 'Libraries'], ['schedules', 'Channel Schedules'], ['editor', 'Channels'], ['mobile-editor', 'Channels']]) {
		await page.setViewportSize({ width: layout.startsWith('mobile') ? 390 : 1440, height: 1000 });
		await visit(`?layout=${layout}`);
		const help = page.getByRole('button', { name: `Help with ${label}`, exact: true });
		await help.click();
		const drawer = page.locator('#help-dialog');
		await expect(drawer).toBeVisible();
		await expect(drawer.getByRole('link', { name: 'Open full guide' })).toHaveAttribute('href', /^\.\/assets\/help\/.*\.html/);
		await page.keyboard.press('Escape');
		await expect(help).toBeFocused();
	}
	await visit('?layout=settings');
	await expect(page.locator('.page-header .page-help')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Help with Playback capacity', exact: true })).toBeVisible();

	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await visit('?layout=library');
		await expect(page.getByRole('combobox')).toHaveCount(0);
		await expect(page.locator('.current-library-status .current-library-stat')).toHaveCount(5);
		await expect(page.locator('.current-status-icon .action-glyph')).toHaveCount(5);
		const statusIcons = await page.locator('.current-status-icon .action-glyph').evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, mask: getComputedStyle(element).maskImage })));
		assert.ok(statusIcons.every(icon => icon.width === 24 && icon.height === 24 && icon.mask !== 'none'));
		await expect(page.getByRole('group', { name: 'Catalog navigation', exact: true }).getByRole('button')).toHaveCount(27);
		await expect(page.getByRole('button', { name: 'Filter media', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Select items', exact: true })).toHaveClass(/icon/);
		const footer = page.locator('.current-library-footer');
		await expect(footer).toContainText('Showing 1–8 of 8');
		await expect(footer.getByRole('button', { name: 'Previous page' })).toBeDisabled();
		await expect(footer.getByRole('button', { name: 'Next page' })).toBeDisabled();
		await expect(footer.locator('[aria-current="page"]')).toHaveText('1');
		const footerBounds = await footer.boundingBox();
		assert.ok(Math.abs(footerBounds.y + footerBounds.height - 844) <= 1);
		await page.getByRole('button', { name: 'Last scan: open scan history', exact: true }).click();
		await expect(page.getByRole('dialog', { name: 'Scan history', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('button', { name: 'Last scan: open scan history', exact: true })).toBeFocused();
		const sort = page.locator('[data-library-sort]');
		await sort.click();
		await expect(page.locator('#library-sort-menu')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(sort).toBeFocused();
		await page.getByRole('button', { name: 'Select items', exact: true }).click();
		await page.getByRole('button', { name: 'Select Page', exact: true }).click();
		await expect(page.locator('[data-media-count]')).toHaveText('8 selected');
		await page.getByRole('button', { name: 'Clear Page', exact: true }).click();
		await expect(page.locator('[data-media-count]')).toHaveText('0 selected');
		await expect(page.getByRole('button', { name: 'Add Selected', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Add All', exact: true })).toBeVisible();
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	}
});

test('source navigation preserves destinations and separates group links from mobile drawer controls', async () => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await visit('?layout=catalog');
	const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
	for (const label of ['Status', 'Quick Setup', 'Guide', 'Channels', 'Filler', 'Playback']) {
		assert.equal(await navigation.getByRole('link', { name: label === 'Status' ? /^Status/ : label, exact: label !== 'Status' }).count(), 1);
	}
	assert.equal(await page.getByRole('link', { name: 'User Guide', exact: true }).count(), 1);
	assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).count(), 1);
	const toggle = navigation.getByRole('button', { name: 'Toggle scheduling navigation' });
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(navigation.getByRole('link', { name: 'Programs', exact: true })).toBeHidden();
	await expect(navigation.getByRole('link', { name: 'Scheduling', exact: true })).toBeVisible();
	await toggle.click();
	await expect(navigation.getByRole('link', { name: 'Programs', exact: true })).toBeVisible();
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		const trigger = page.getByRole('button', { name: 'Open navigation', exact: true });
		await trigger.click();
		const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
		await expect(drawer).toBeVisible();
		assert.equal(await page.locator('#help-dialog').isVisible(), false);
		await expect(drawer.getByRole('link', { name: 'User Guide', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(trigger).toBeFocused();
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	}
});

test('Program rows retain mobile inspection, type details and routed editing', async () => {
	for (const width of [1440, 1220, 900, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		await visit('?layout=catalog');
		const row = page.locator('.current-program-identity').nth(1);
		await row.click();
		const surface = width <= 1220 ? page.getByRole('dialog', { name: 'Program details', exact: true }) : page.locator('.workspace > .inspector');
		await expect(surface).toBeVisible();
		await expect(surface.getByRole('heading', { name: 'Weekend discoveries', exact: true })).toBeVisible();
		await expect(surface.getByRole('heading', { name: 'Sequence Configuration', exact: true })).toBeVisible();
		await expect(surface.getByRole('link', { name: 'Edit Program', exact: true })).toHaveAttribute('href', '?layout=program-editor');
		await surface.getByRole('button', { name: 'Close program inspector', exact: true }).click();
		await expect(row).toBeFocused();
		await expect(row).toHaveAttribute('aria-pressed', 'false');
		await page.locator('.current-program-identity').first().click();
		const content = width <= 1220 ? page.getByRole('dialog', { name: 'Program details', exact: true }) : page.locator('.workspace > .inspector');
		await expect(content.getByRole('link', { name: 'Edit Program', exact: true })).toHaveAttribute('href', '?family=programs');
		await content.getByRole('button', { name: 'Close program inspector', exact: true }).click();
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	}
	await page.getByRole('button', { name: 'New Program', exact: true }).click();
	await expect(page).toHaveURL(/family=programs/);
});

test('help keeps real bundled topics, local full-guide links and persistent asynchronous variants', async () => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await visit('?family=overlays');
	await page.getByRole('button', { name: 'Show loading help example' }).click();
	await expect(page.locator('#help-dialog').getByRole('status')).toContainText('Loading help');
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Show failed help example' }).click();
	await expect(page.locator('#help-dialog').getByRole('alert')).toContainText('Help is unavailable');
	await page.locator('#help-dialog').getByRole('button', { name: 'Retry', exact: true }).click();
	await expect(page.locator('#help-topic-title')).toBeVisible();
	await expect(page.locator('#help-dialog').getByRole('link', { name: 'Open full guide' })).toHaveAttribute('href', /assets\/help\/.*\.html/);
	await expect(page.locator('#help-dialog .help-markdown')).not.toBeEmpty();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Show failed help example' })).toBeFocused();
});

test('channel preference dependencies and the schedule draft guard match their owners', async () => {
	await visit('?layout=editor');
	await expect(page.locator('[data-channel-schedule]')).toBeVisible();
	await page.getByLabel('Name', { exact: true }).fill('A changed channel');
	await expect(page.locator('[data-channel-schedule]')).toBeHidden();
	await expect(page.locator('[data-channel-schedule-disabled]')).toBeDisabled();
	await page.locator('.subtitle-policies label').filter({ has: page.getByRole('radio', { name: /^Off/ }) }).click();
	await expect(page.locator('[data-subtitle-rules]')).toBeHidden();
	await page.locator('.subtitle-policies label').filter({ has: page.getByRole('radio', { name: /^Forced only/ }) }).click();
	await page.locator('[data-subtitle-language]').selectOption({ label: 'Specific language' });
	const language = page.getByRole('combobox', { name: 'Specific subtitle language', exact: true });
	await language.fill('English');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(language).toHaveValue('eng');
	await page.locator('[data-subtitle-title]').selectOption({ label: 'Specific title' });
	await expect(page.getByLabel('Subtitle title contains', { exact: true })).toBeVisible();
	await expect(page.locator('[data-save]')).toBeDisabled();
	await page.getByLabel('Subtitle title contains', { exact: true }).fill('Forced');
	await expect(page.locator('[data-save]')).toBeEnabled();
	const encoding = page.locator('[data-encoding-reference]');
	await encoding.locator('details > summary').click();
	await expect(encoding.locator('[data-linked-settings]').first().getByRole('combobox').first()).toBeDisabled();
	await encoding.locator('select').first().selectOption('Custom');
	await expect(encoding.locator('[data-linked-settings]').first().getByRole('combobox').first()).toBeEnabled();
});

test('Sequence editor protects drafts, validates counts and retains approved step handles', async () => {
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await visit('?layout=program-editor');
		const form = page.locator('[data-program-editor]');
		const header = await form.locator('.editor-header').boundingBox();
		const close = await form.locator('[data-program-close]').boundingBox();
		assert.ok(close.x > header.x + header.width - 90 && close.y < header.y + 45);
		await expect(form.locator('[data-program-save]')).toHaveText('Close');
		await form.getByLabel('Name', { exact: true }).fill('Revised sequence');
		await expect(form.locator('[data-program-save]')).toHaveText('Save');
		await form.getByLabel('Selections', { exact: true }).first().fill('0');
		await expect(form.locator('[data-program-save]')).toBeDisabled();
		await form.getByLabel('Selections', { exact: true }).first().fill('2');
		await form.getByRole('button', { name: 'Move Evening cinema down', exact: true }).click();
		await expect(form.getByRole('combobox', { name: 'Program', exact: true }).first()).toHaveValue('Night flight');
		await expect(form.locator('.sequence-number').first()).toHaveText('1');
		await form.getByRole('button', { name: 'Shuffled blocks', exact: true }).click();
		await expect(form.locator('[data-sequence-seed]')).toBeVisible();
		await form.locator('[data-program-close]').click();
		await expect(page.locator('#confirm-dialog')).toBeVisible();
		await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
		await form.locator('[data-program-save]').click();
		await expect(form.locator('[data-program-save]')).toHaveText('Close');
		await form.getByLabel('Name', { exact: true }).fill('Unsaved again');
		await form.locator('[data-program-reset]').click();
		await form.getByRole('button', { name: /^Confirm reset$/i }).click();
		await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Revised sequence');
		const footer = await form.locator('.editor-footer').boundingBox();
		assert.ok(footer.y + footer.height <= 844);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	}
});

test('AI custom-provider dependencies and structured log filtering remain local and source-shaped', async () => {
	await visit('?layout=settings');
	await page.getByRole('tab', { name: 'AI', exact: true }).click();
	await page.locator('[data-ai-provider]').selectOption('Custom');
	await page.getByRole('button', { name: 'Toggle advanced AI settings', exact: true }).click();
	await expect(page.getByLabel('Endpoint base URL', { exact: true })).toBeVisible();
	await page.getByRole('combobox', { name: 'API format', exact: true }).selectOption('Anthropic Messages');
	await expect(page.getByRole('combobox', { name: 'JSON mode', exact: true })).toBeHidden();
	await page.getByLabel('Endpoint base URL', { exact: true }).fill('http://localhost:8080/v1');
	await expect(page.locator('[data-ai-plaintext]')).toBeVisible();
	await page.locator('[data-ai-research]').check();
	await expect(page.getByRole('combobox', { name: /^Web research time limit/ })).toBeVisible();
	await visit('?family=operations');
	await page.locator('[data-log-level]').selectOption('Error');
	await expect(page.locator('[data-log-entry]:visible')).toHaveCount(1);
	await page.locator('[data-log-entry]:visible').click();
	await expect(page.getByRole('dialog', { name: 'Log entry details', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.locator('[data-log-entry]:visible')).toBeFocused();
});

test('Guide listings open source-shaped details and return keyboard focus', async () => {
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await visit('?layout=guide');
		const listing = page.locator('[data-guide-slot]').first();
		await listing.focus();
		await page.keyboard.press('Enter');
		const detail = page.getByRole('dialog', { name: 'Schedule item details', exact: true });
		await expect(detail).toBeVisible();
		await expect(detail).toContainText('Afterlight Station');
		assert.equal((await detail.boundingBox()).width, Math.min(880, width - 32));
		await expect(detail.getByRole('link', { name: 'View Media Details' })).toHaveAttribute('href', './components/media.md#preview-and-adaptation');
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
		await page.keyboard.press('Escape');
		await expect(detail).toHaveCount(0);
		await expect(listing).toBeFocused();
	}
});


test('review corrections retain shell geometry, separate Status/Logs and popup engine details', async () => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await visit('?layout=catalog');
	const status = page.locator('nav .status-nav-link').first();
	const bounds = await status.boundingBox();
	for (const line of await status.locator('strong, small').all()) {
		const box = await line.boundingBox();
		assert.ok(box.y >= bounds.y && box.y + box.height <= bounds.y + bounds.height);
	}
	const type = await status.locator('small').first().evaluate(element => ({ color: getComputedStyle(element).color, size: parseFloat(getComputedStyle(element).fontSize) }));
	assert.ok(type.size < 12);
	assert.equal(type.color, await status.evaluate(element => getComputedStyle(element).getPropertyValue('--color-accent').trim()).then(hex => `rgb(${hex.match(/[\da-f]{2}/gi).map(value => parseInt(value, 16)).join(', ')})`));
	await expect(page.locator('.sidebar nav hr')).toHaveCount(0);
	assert.equal(await page.locator('.current-sidebar-account').first().evaluate(element => getComputedStyle(element, '::before').borderTopWidth), '1px');
	const account = page.locator('.current-sidebar-account > a').first();
	assert.equal(await account.evaluate(element => getComputedStyle(element).display), 'flex');
	await status.click();
	await expect(page.getByRole('heading', { name: 'Status', exact: true })).toBeVisible();
	await expect(page.locator('#logs')).toHaveCount(0);
	await page.locator('nav [data-app-path="/logs"]').first().click();
	await expect(page.getByRole('heading', { name: 'Logs', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Active channels', exact: true })).toHaveCount(0);
	await visit('?layout=library');
	assert.equal(await page.locator('.current-library-sort').evaluate(element => getComputedStyle(element).borderTopColor), await page.locator('.current-library-tool').first().evaluate(element => getComputedStyle(element).borderTopColor));
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		for (const layout of ['status', 'logs']) {
			await visit(`?layout=${layout}`);
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, layout);
			const help = page.getByRole('button', { name: `Help with ${layout === 'status' ? 'Status' : 'Logs'}`, exact: true });
			await help.click();
			await expect(page.locator('#help-dialog').getByRole('link', { name: 'Open full guide' })).toHaveAttribute('href', /operations\.status\.html/);
			await page.keyboard.press('Escape');
			await expect(help).toBeFocused();
		}
	}
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		await visit('?layout=settings');
		const card = page.locator('.settings-readiness');
		const before = await card.boundingBox();
		await page.getByRole('button', { name: 'Engine details', exact: true }).click();
		await expect(page.locator('#settings-engine-details')).toBeVisible();
		assert.deepEqual(await card.boundingBox(), before);
		const popup = await page.locator('#settings-engine-details').boundingBox();
		assert.ok(popup.x >= 16 && popup.x + popup.width <= width - 16);
		await page.keyboard.press('Escape');
		await expect(page.locator('#settings-engine-details')).toBeHidden();
		await expect(page.getByRole('button', { name: 'Engine details', exact: true })).toBeFocused();
	}
});

test('Guide feed buttons copy their URLs and Channel editor retains source framing', async () => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await visit('?layout=guide');
	await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => {
		window.referenceCopiedURL = value;
	} } }));
	await expect(page.locator('.guide-feed input')).toHaveCount(0);
	for (const label of ['M3U', 'XMLTV']) {
		const button = page.getByRole('button', { name: `Copy ${label} URL`, exact: true });
		await button.click();
		assert.equal(await page.evaluate(() => window.referenceCopiedURL), await button.getAttribute('data-feed-url'));
		await expect(page.locator('.toast-region')).toContainText('URL copied');
	}
	for (const image of await page.locator('.guide-card-artwork').all()) {
		assert.equal(await image.evaluate(element => element.complete && element.naturalWidth > 0 && getComputedStyle(element).maskImage !== 'none'), true);
	}
	await visit('?layout=editor');
	for (const section of await page.locator('.channel-reference-editor fieldset').all()) {
		assert.equal(await section.evaluate(element => getComputedStyle(element).borderTopWidth), '1px');
	}
	await expect(page.locator('.reference-channel-logo')).toContainText('PNG on save');
	await expect(page.getByRole('radio', { name: /^Off/ })).toBeChecked();
	await expect(page.getByRole('combobox', { name: 'Subtitle mode', exact: true })).toBeVisible();
	for (const glyph of await page.locator('.reference-disclosure-icon .action-glyph').all()) {
		assert.notEqual(await glyph.evaluate(element => getComputedStyle(element).maskImage), 'none');
	}
});
