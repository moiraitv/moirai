import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from '../documentation/fixture';
import { seedSchedule } from '../documentation/seed';
import { authenticateAdministrator } from '../authentication';

test('aligns contextual help beside headings throughout pages, settings and resource editors', async ({ page, documentationServer }, testInfo) => {
	const { libraryId, mediaIds, channel } = await seedSchedule(page, documentationServer.directory);
	const routes: (string | { path: string; open: string })[] = ['/', '/quick', '/channels', '/schedules/programs', '/schedules/templates', '/schedules/channels', '/filler/pre-rolls', '/filler/mid-rolls', '/filler/post-rolls', '/filler/tail-fillers', '/playback/encoding-profiles', '/playback/credit-templates', '/playback/guide-templates', '/libraries', `/libraries/${libraryId}`, `/libraries/${libraryId}/items/${mediaIds[0]}`, '/guide', '/account', '/logs', '/settings/playback', '/settings/ai', '/settings/backups', '/libraries/new', `/libraries/${libraryId}/settings`, '/schedules/programs/new', '/schedules/templates/new', `/schedules/channels/${channel.id}`, `/channels/${channel.id}`, '/playback/encoding-profiles/new', '/playback/credit-templates/new', '/playback/guide-templates/new', '/filler/pre-rolls/new', '/filler/mid-rolls/new', '/filler/post-rolls/new', '/filler/tail-fillers/new', { path: '/quick', open: 'Movie Channel' }];
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		for (const entry of routes) {
			const route = typeof entry === 'string' ? entry : entry.path;
			await page.goto(route);
			await expect(page.locator('.loading-state')).toHaveCount(0);
			if (typeof entry !== 'string') {
				await page.getByRole('button', { name: entry.open }).click();
			}
			await page.evaluate(() => document.fonts.ready);
			const dialog = page.getByRole('dialog').last();
			const owner = await dialog.count() ? dialog : page.locator('main');
			await expect(owner.locator('.page-help-button:visible').first()).toBeVisible();
			const pairs = await owner.locator('.page-help-button').evaluateAll(buttons => buttons.filter(button => button.getClientRects().length > 0).map(button => {
				const heading = button.previousElementSibling!;
				const range = document.createRange();
				range.selectNodeContents(heading.querySelector('strong') ?? heading);
				const text = range.getBoundingClientRect();
				const help = button.getBoundingClientRect();
				const glyph = button.querySelector('svg')!.getBoundingClientRect();
				return {
					label: button.getAttribute('aria-label'),
					gap: help.left - heading.getBoundingClientRect().right,
					centerOffset: help.y + help.height / 2 - text.y - text.height / 2,
					width: help.width, height: help.height, glyph: glyph.width,
				};
			}));
			for (const pair of pairs) {
				const context = `${route} at ${width}px: ${pair.label}`;
				expect.soft(Math.abs(pair.gap - 8), context).toBeLessThanOrEqual(0.5);
				expect.soft(Math.abs(pair.centerOffset), context).toBeLessThanOrEqual(1.5);
				expect.soft([pair.width, pair.height, pair.glyph], context).toEqual([24, 24, 20]);
			}
		}
		await page.goto(`/libraries/${libraryId}/settings`);
		await expect(page.getByRole('dialog')).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath(`library-help-${width}.png`) });
		const help = page.getByRole('dialog').getByRole('button', { name: 'Help with Libraries', exact: true });
		await help.focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('.help-drawer')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(help).toBeFocused();
	}
});

test('distinguishes selected sidebar destinations from hover across desktop and mobile', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/');
	const colors = await page.evaluate(() => {
		const probe = document.createElement('span');
		probe.style.setProperty('transition', 'none', 'important');
		document.body.append(probe);
		const resolve = (name: string) => {
			probe.style.color = `var(${name})`;
			return getComputedStyle(probe).color;
		};
		const result = { accent: resolve('--color-accent'), selected: resolve('--color-selected'), hover: resolve('--color-hover') };
		probe.remove();
		return result;
	});
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		for (const [path, label] of [['/', 'Status'], ['/guide', 'Guide'], ['/channels', 'Channels'], ['/filler/tail-fillers', 'Filler'], ['/playback/credit-templates', 'Playback'], ['/settings', 'Settings'], ['/schedules/programs', 'Programs']] as const) {
			await page.goto(path!);
			if (width <= 900) {
				await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
			}
			const navigation = page.locator('.primary-nav');
			const selected = navigation.getByRole('link', { name: label === 'Status' ? /^Status/ : label, exact: label !== 'Status' });
			await selected.scrollIntoViewIfNeeded();
			for (const hovered of [false, true]) {
				if (hovered) {
					await selected.hover();
				}
				await expect(selected).toHaveCSS('color', colors.accent);
				await expect(selected).toHaveCSS('background-color', colors.selected);
				await expect(selected).toHaveCSS('border-left-color', colors.accent);
				await expect(selected).toHaveCSS('border-left-width', '2px');
			}
			const inactive = navigation.getByRole('link', { name: label === 'Settings' ? 'Logs' : 'Settings', exact: true });
			await expect(inactive).not.toHaveCSS('background-color', colors.selected);
			await inactive.hover();
			await expect(inactive).toHaveCSS('background-color', colors.hover);
			await expect(inactive).not.toHaveCSS('border-left-color', colors.accent);
		}
	}
});

test('applies runtime foundations across routes without replacing source layouts', async ({ page, documentationServer }, testInfo) => {
	await page.goto('/');
	await expect(page.locator('.authentication-card')).toBeVisible();
	await expect(page.locator('.authentication-card .button:not(.secondary)')).toHaveCSS('color', 'rgb(255, 255, 255)');
	await page.screenshot({ path: testInfo.outputPath('authentication.png') });
	const { libraryId, channel } = await seedSchedule(page, documentationServer.directory);
	const routes = ['/', '/quick', '/channels', '/schedules/programs', '/schedules/templates', '/schedules/channels', '/filler/pre-rolls', '/filler/mid-rolls', '/filler/post-rolls', '/filler/tail-fillers', '/playback/encoding-profiles', '/playback/credit-templates', '/playback/guide-templates', '/libraries', `/libraries/${libraryId}`, '/guide', '/settings', '/account', '/logs', '/missing-design-example'];
	for (const width of [320, 390, 1440]) {
		await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
		for (const [index, route] of routes.entries()) {
			await page.goto(route);
			await expect(page.locator('.loading-state')).toHaveCount(0);
			await page.evaluate(async () => {
				await document.fonts.ready;
				await Promise.all([...document.images].filter(image => image.complete && image.naturalWidth).map(image => image.decode()));
			});
			await expect(page.getByRole('heading').first()).toBeVisible();
			const state = await page.evaluate(() => ({
				font: document.fonts.check('500 14px Inter'),
				radius: getComputedStyle(document.documentElement).getPropertyValue('--radius-control').trim(),
				overflow: document.documentElement.scrollWidth > window.innerWidth,
			}));
			if (state.overflow) {
				console.log('Overflow', route, width, await page.evaluate(() => [...document.querySelectorAll('main *')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(element => ({ tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width }))));
			}
			expect(state, `${route} at ${width}px`).toEqual({ font: true, radius: '4px', overflow: false });
			await page.evaluate(() => window.scrollTo(0, 0));
			await page.screenshot({ path: testInfo.outputPath(`route-${index}-${width}.png`), animations: 'disabled' });
		}
		await page.goto(`/channels/${channel.id}`);
		const editor = page.getByRole('dialog', { name: 'Edit Channel', exact: true });
		await expect(editor).toBeVisible();
		await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
		await expect(editor.getByRole('button', { name: 'Reset', exact: true })).toHaveText('Reset', { useInnerText: true });
		if (width <= 600) {
			const fields = editor.locator('input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="hidden"]), select');
			for (const field of await fields.all()) {
				if (await field.isVisible()) {
					expect((await field.boundingBox())!.height, await field.evaluate(element => element.closest('label')?.textContent?.trim() ?? element.tagName)).toBeGreaterThanOrEqual(44);
				}
			}
		}
		await editor.locator('.resource-editor-scroll').evaluate(element => {
			element.scrollTop = element.scrollHeight; 
		});
		await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
		await page.screenshot({ path: testInfo.outputPath(`channel-editor-${width}.png`) });
	}
	for (const width of [600, 601, 900, 901, 1220, 1221]) {
		await page.setViewportSize({ width, height: 1000 });
		await page.goto('/schedules/programs');
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/channels/${channel.id}`);
	await page.addStyleTag({ content: 'html { font-size: 200%; }' });
	const scaled = page.getByRole('dialog', { name: 'Edit Channel', exact: true });
	await expect(scaled.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
	await expect(scaled.getByRole('button', { name: 'Reset', exact: true })).toHaveText('Reset', { useInnerText: true });
	await page.screenshot({ path: testInfo.outputPath('editor-text-scale-200.png') });
});

test('keeps reviewed Sequence confirmation geometry and production overlay behavior', async ({ page, documentationServer }, testInfo) => {
	const { sequenceProgramIds, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const response = await page.request.post('/api/v1/programs', { headers: requestHeaders, data: {
		name: 'Design adoption Sequence', config: { type: 'sequence', repeat: true, entries: sequenceProgramIds.map(programId => ({ id: randomUUID(), programId, count: 2 })) },
	} });
	expect(response.ok()).toBe(true);
	const { id } = await response.json() as { id: string };
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
		await page.goto(`/schedules/programs/${id}`);
		const remove = page.getByRole('button', { name: 'Remove sequence step 1', exact: true });
		await remove.scrollIntoViewIfNeeded();
		const before = await remove.boundingBox();
		const step = await remove.locator('..').boundingBox();
		expect(Math.abs(before!.y + before!.height / 2 - step!.y - step!.height / 2)).toBeLessThanOrEqual(1);
		await remove.click();
		const armed = page.getByRole('button', { name: 'Confirm remove sequence step 1', exact: true });
		expect(await armed.boundingBox()).toEqual(before);
		await expect(armed).toHaveAttribute('aria-pressed', 'true');
		await page.keyboard.press('Escape');
		await expect(remove).toHaveAttribute('aria-pressed', 'false');
		await remove.click();
		await page.getByRole('spinbutton', { name: 'Step 1 count', exact: true }).focus();
		await expect(remove).toHaveAttribute('aria-pressed', 'false');
		const arrows = page.getByRole('group', { name: 'Order step 1', exact: true });
		const up = await arrows.getByRole('button', { name: 'Move step 1 up', exact: true }).boundingBox();
		const down = await arrows.getByRole('button', { name: 'Move step 1 down', exact: true }).boundingBox();
		expect(up!.x).toBe(down!.x);
		expect(up!.y + up!.height).toBeLessThanOrEqual(down!.y + 1);
		await expect(arrows.getByRole('button', { name: 'Move step 1 up', exact: true })).toBeDisabled();
		await page.screenshot({ path: testInfo.outputPath(`sequence-${width}.png`) });
		await page.goto('/settings');
		const trigger = page.getByRole('button', { name: 'Engine details', exact: true });
		const status = page.locator('.settings-status');
		await expect(trigger).toBeVisible();
		const resting = await status.boundingBox();
		await trigger.click();
		await expect(page.locator('.settings-engine-details')).toBeVisible();
		expect(await status.boundingBox()).toEqual(resting);
		await page.keyboard.press('Escape');
		await expect(page.locator('.settings-engine-details')).not.toBeVisible();
		await expect(trigger).toBeFocused();
		await trigger.click();
		await page.getByRole('heading', { name: 'Settings', exact: true }).click();
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	}
});

test('retains the grouped library filter and compact feed-copy actions', async ({ page, documentationServer, context }) => {
	const { libraryId } = await seedSchedule(page, documentationServer.directory);
	await page.goto(`/libraries/${libraryId}`);
	await page.getByRole('button', { name: 'Filter media', exact: true }).click();
	const filter = page.getByRole('dialog', { name: 'Filter media', exact: true });
	const rating = await filter.getByLabel('Minimum popular rating', { exact: true }).boundingBox();
	const userRating = await filter.getByLabel('Minimum user rating', { exact: true }).boundingBox();
	const actor = await filter.getByLabel('Actor', { exact: true }).boundingBox();
	const director = await filter.getByLabel('Director', { exact: true }).boundingBox();
	expect(rating!.y).toBe(userRating!.y);
	expect(actor!.y).toBe(director!.y);
	await expect(filter.locator('.filter-duration-inputs input')).toHaveCount(6);
	await expect(filter.locator('.genre-rule-split button').first().locator('svg')).toHaveCSS('color', 'rgb(255, 209, 138)');
	await page.keyboard.press('Escape');
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.goto('/guide');
	const feed = page.locator('.epg-feed-card');
	const before = await feed.boundingBox();
	await page.getByRole('button', { name: 'Copy M3U playlist URL', exact: true }).click();
	await expect(page.locator('.transient-toast')).toContainText('Playlist URL copied');
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/iptv\/channels\.m3u$/);
	expect(await feed.boundingBox()).toEqual(before);
	await page.getByRole('button', { name: 'Copy XMLTV guide URL', exact: true }).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/epg\.xml$/);
});


test('aligns catalog navigation and sort heights for tablet touch and mouse input', async ({ page, browser, documentationServer }) => {
	const { libraryId } = await seedSchedule(page, documentationServer.directory);
	for (const hasTouch of [false, true]) {
		const context = await browser.newContext({ baseURL: documentationServer.url, hasTouch, reducedMotion: 'reduce' });
		try {
			const catalog = await context.newPage();
			await authenticateAdministrator(catalog);
			for (const width of [1440, 1024, 768, 600, 390, 320]) {
				await catalog.setViewportSize({ width, height: 1000 });
				await catalog.goto(`/libraries/${libraryId}`);
				const strip = catalog.locator('.alphabet-filter');
				const sort = catalog.getByRole('button', { name: /^Sort by:/ });
				await expect(sort).toBeVisible();
				const stripBox = await strip.boundingBox();
				const sortBox = await sort.boundingBox();
				expect(Math.abs(stripBox!.height - sortBox!.height)).toBeLessThanOrEqual(1);
				if (hasTouch) {
					const minimum = await catalog.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--target-touch')));
					const letter = await strip.getByRole('button').first().boundingBox();
					expect(letter!.height).toBeGreaterThanOrEqual(minimum);
				}
				await catalog.screenshot({ path: `test-results/catalog-toolbar-${hasTouch ? 'touch' : 'mouse'}-${width}.png` });
			}
		}
		finally {
			await context.close();
		}
	}
});
