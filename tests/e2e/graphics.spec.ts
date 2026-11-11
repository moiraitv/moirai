import { randomUUID } from 'node:crypto';
import { expect, test, type Locator } from '@playwright/test';
import { emptyGraphicsMedia, graphicsExampleIds, MAX_GRAPHICS_TEXT_LENGTH } from '@moirai/shared';
import { parse } from 'yaml';
import { authenticateAdministrator } from './authentication';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

async function addLayer(editor: Locator, kind: 'media' | 'text' | 'shape' | 'clock'): Promise<void> {
	await editor.getByRole('button', { name: 'Add layer', exact: true }).click();
	await editor.getByRole('button', { name: `Add ${kind}`, exact: true }).click();
}

test('opens Graphics below Filler and edits a protected example through visual and YAML modes', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/graphics');

	const graphics = page.getByRole('link', { name: 'Graphics', exact: true });
	await expect(graphics).toBeVisible();
	expect(await graphics.evaluate(link => link.previousElementSibling?.textContent?.trim())).toBe('Filler');
	const examples = page.locator('article').filter({ hasText: 'Example' });
	await expect(examples).toHaveCount(graphicsExampleIds.length);
	await expect(examples.getByRole('heading')).toHaveText(['Corner Watermark', 'Now Playing & Up Next', 'Channel ID', 'Animated Corner Bug', 'Live Clock', 'Upcoming Ticker']);
	await expect(examples.locator('.graphics-monitor-still')).toHaveCount(graphicsExampleIds.length);
	await expect(examples.filter({ hasText: 'Channel ID' }).locator('.graphics-canvas')).toContainText('Moirai TV');
	await expect(examples.filter({ hasText: 'Now Playing & Up Next' }).locator('.graphics-canvas')).toContainText('Mountain Rescue');

	await expect(examples.filter({ hasText: 'Upcoming Ticker' }).locator('.graphics-canvas')).toContainText('Alpine Wildlife');
	await expect(examples.filter({ hasText: 'Live Clock' }).locator('.graphics-canvas img[alt="14:27:41"]')).toBeVisible();
	const animated = examples.filter({ hasText: 'Animated Corner Bug' });
	const poster = animated.locator('.graphics-canvas-layer img');
	await expect(poster).toHaveAttribute('src', /\/poster$/);
	const still = await page.request.get((await poster.getAttribute('src'))!);
	expect(still.headers()['content-type']).toContain('image/png');
	expect(still.ok()).toBe(true);

	const clock = examples.filter({ hasText: 'Live Clock' });
	await clock.getByRole('button', { name: 'Duplicate' }).click();
	const clockEditor = page.getByRole('dialog');
	await expect(clockEditor.getByLabel('Digit color')).toHaveValue('#ffffff');
	await expect(clockEditor.getByLabel('Background opacity (%)')).toHaveValue('90');
	await clockEditor.getByRole('button', { name: 'Close graphics preset' }).click();

	const card = examples.filter({ hasText: 'Corner Watermark' });
	const editor = page.getByRole('dialog');
	await card.getByRole('button', { name: 'Preview', exact: true }).click();
	const tools = editor.getByRole('group', { name: 'Layer actions' });
	for (const label of ['Add layer', 'Remove layer', 'Duplicate layer']) {
		const control = tools.getByRole('button', { name: label, exact: true });
		await expect(control).toBeVisible();
		await expect(control).toBeDisabled();
	}
	await editor.getByRole('button', { name: 'Duplicate', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Visual' })).toHaveAttribute('aria-pressed', 'true');
	await expect(editor.getByLabel('Layer name')).toHaveValue('Watermark');
	await editor.getByLabel('Width (%)').fill('50');
	await editor.getByLabel('Width (%)').press('Tab');
	const image = editor.locator('.graphics-canvas-layer img');
	await expect.poll(async () => image.evaluate(element => {
		const bounds = element.getBoundingClientRect();
		return Math.abs(bounds.width - element.parentElement!.getBoundingClientRect().width);
	})).toBeLessThan(1);
	const assetUrl = (await image.getAttribute('src'))!;
	const partial = await page.request.get(assetUrl, { headers: { Range: 'bytes=0-1' } });
	expect(partial.status()).toBe(206);
	expect(partial.headers()['content-range']).toMatch(/^bytes 0-1\/\d+$/);
	expect(await partial.body()).toHaveLength(2);
	const invalid = await page.request.get(assetUrl, { headers: { Range: 'bytes=99999999-' } });
	expect(invalid.status()).toBe(416);
	expect(invalid.headers()['content-range']).toMatch(/^bytes \*\/\d+$/);

	await editor.getByLabel('Horizontal margin (%)').fill('99');
	await editor.getByLabel('Vertical margin (%)').fill('99');
	await editor.getByLabel('Vertical margin (%)').press('Tab');
	const layer = editor.getByRole('button', { name: 'Select layer 1' });
	await expect.poll(async () => {
		const [frame, graphic] = await Promise.all([editor.locator('.graphics-canvas').boundingBox(), layer.boundingBox()]);
		return frame && graphic ? Math.abs(graphic.x - frame.x) + Math.abs(graphic.y - frame.y) : Infinity;
	}).toBeLessThan(1);
	await editor.getByLabel('Vertical margin (%)').fill('5');
	await editor.getByLabel('Horizontal margin (%)').fill('12');
	await editor.getByLabel('Horizontal margin (%)').press('Tab');
	await editor.getByRole('button', { name: 'YAML' }).click();
	const yaml = editor.getByRole('textbox', { name: 'Graphics YAML' });
	const source = await yaml.inputValue();
	expect(source).toContain('horizontalMargin: 12');
	await yaml.fill('version: 1\nlayers: [');
	await expect(editor.getByRole('alert')).toBeVisible();
	await expect(editor.getByRole('button', { name: 'Visual' })).toBeDisabled();
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

	await yaml.fill(`# Operator note\n${source}`);
	await editor.getByRole('button', { name: 'Visual' }).click();
	await editor.getByLabel('Vertical margin (%)').fill('9');
	await editor.getByLabel('Vertical margin (%)').press('Tab');
	await editor.getByRole('button', { name: 'YAML' }).click();
	await expect(yaml).toHaveValue(/# Operator note/);
	await expect(yaml).toHaveValue(/verticalMargin: 9/);
	const name = `Watermark ${randomUUID().slice(0, 8)}`;
	await editor.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(/\/graphics\/[\da-f-]{36}$/);
	await editor.getByRole('button', { name: 'Close graphics preset' }).click();
	await expect(page.getByRole('heading', { name })).toBeVisible();
	await expect(page.locator('article').filter({ has: page.getByRole('heading', { name }) }).locator('.graphics-canvas-layer img')).toHaveAttribute('src', assetUrl);
});

test('saves and reopens an on-screen graphics assignment on a filler preset', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/filler/pre-rolls/new');
	const editor = page.getByRole('dialog');
	const name = `Branded break ${randomUUID().slice(0, 8)}`;
	await editor.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
	await editor.getByRole('button', { name: 'On-screen graphics', exact: true }).click();
	const mode = editor.getByRole('combobox', { name: 'Graphics assignment' });
	await expect(mode.getByRole('option', { name: 'Replace inherited graphics' })).toBeEnabled();
	await mode.selectOption('replace');
	await editor.getByRole('combobox', { name: 'Graphics preset' }).selectOption(graphicsExampleIds[3]!);
	await editor.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page).toHaveURL(/\/filler\/pre-rolls\/[a-f0-9-]{36}$/);
	await editor.getByRole('button', { name: 'Close Pre-Roll' }).click();
	await expect(editor).toBeHidden();
	await page.locator('article').filter({ hasText: name }).getByRole('button', { name: 'Edit' }).click();
	await editor.getByRole('button', { name: 'On-screen graphics', exact: true }).click();
	await expect(mode).toHaveValue('replace');
	await expect(editor.getByRole('combobox', { name: 'Graphics preset' })).toHaveValue(graphicsExampleIds[3]!);
});

test('loops gallery samples only while their card is visible', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.setViewportSize({ width: 390, height: 844 });
	await authenticateAdministrator(page);
	await page.route('**/api/v1/graphics/presets/*/sample-clip', route => route.fulfill({
		path: 'apps/server/assets/dead-air.mp4', contentType: 'video/mp4',
	}));
	await page.goto('/graphics');
	const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Animated Corner Bug' }) });
	const video = card.locator('video.graphics-sample-video');
	await expect(card.locator('.graphics-monitor-still')).toHaveCount(1);
	await expect(video).toHaveCount(0);
	await card.scrollIntoViewIfNeeded();
	await expect(video).toHaveAttribute('loop', '');
	await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
	await page.getByRole('heading', { name: 'Graphics', exact: true }).scrollIntoViewIfNeeded();
	await expect(video).toHaveCount(0);
});

test('plays a saved sample in its gallery card and stops it when opening the editor', async ({ page }) => {
	await authenticateAdministrator(page);
	const sample = `**/api/v1/graphics/presets/${graphicsExampleIds[3]}/sample-clip`;
	await page.route(sample, route => route.fulfill({
		status: 503, json: { message: 'The graphics preview engine is unavailable or busy' },
	}), { times: 1 });
	await page.goto('/graphics');
	const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Animated Corner Bug' }) });
	await card.getByRole('button', { name: 'Play sample' }).click();
	await expect(card.getByRole('alert')).toBeVisible();
	await expect(card.locator('.graphics-monitor-still')).toBeVisible();

	await page.route(sample, route => route.fulfill({ path: 'apps/server/assets/dead-air.mp4', contentType: 'video/mp4' }));
	await card.getByRole('button', { name: 'Play sample' }).click();
	const video = card.locator('video.graphics-sample-video');
	await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
	await expect(card.getByRole('alert')).toHaveCount(0);
	await card.getByRole('button', { name: 'Duplicate' }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await expect(video).toHaveCount(0);
});

test('keeps the visual editor usable when a Liquid field would exceed the text limit', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/graphics/new');
	const editor = page.getByRole('dialog');
	await addLayer(editor, 'text');
	const text = editor.getByRole('textbox', { name: 'Text or Liquid template' });
	const full = 'x'.repeat(MAX_GRAPHICS_TEXT_LENGTH);
	await text.fill(full);
	await editor.getByRole('button', { name: 'Insert Liquid field' }).click();
	await editor.getByRole('button', { name: 'Insert now.title' }).click();
	await expect(text).toHaveValue(full);
	await expect(editor.getByRole('button', { name: 'Visual' })).toBeEnabled();
});

test('finds and inserts music video fields and renders them in the channel preview', async ({ page }) => {
	await authenticateAdministrator(page);
	const channel = { id: randomUUID(), number: '48', name: 'Music TV', logo: null };
	const artists = ['Indigo [credit]Coast[/credit]', 'Ava Reed'];
	const album = 'Night Signals';
	await page.route('**/api/v1/channels', route => route.fulfill({ json: [channel] }));
	await page.route('**/api/v1/graphics/preview-context?**', route => route.fulfill({ json: {
		availability: 'available', context: { channel, media: { ...emptyGraphicsMedia, kind: 'music-video', artists, album },
			now: null, next: null, upcoming: [] },
	} }));

	await page.goto('/graphics/new');
	const editor = page.getByRole('dialog', { name: 'New Graphics Preset' });
	await addLayer(editor, 'text');
	const openFields = editor.getByRole('button', { name: 'Insert Liquid field' });
	const fields = page.getByRole('dialog', { name: 'Liquid values' });
	const search = fields.getByRole('searchbox', { name: 'Search Liquid fields' });
	await openFields.click();
	await expect(search).toBeFocused();
	await search.fill('credited song artists');
	await expect(fields.getByRole('button', { name: 'Insert now.title' })).toHaveCount(0);
	await fields.getByRole('button', { name: 'Insert media.artists', exact: true }).click();
	await openFields.click();
	await search.fill('media.album');
	await fields.getByRole('button', { name: 'Insert media.album', exact: true }).click();
	await expect(editor.getByRole('textbox', { name: 'Text or Liquid template' })).toHaveValue(/{{ media.artists \| join: ', ' }} {{ media.album }}/);

	await editor.getByRole('combobox', { name: 'Preview channel' }).click();
	await editor.getByRole('option', { name: /Music TV/ }).click();
	await expect(editor.locator('.graphics-canvas')).toContainText(`${artists.join(', ')} ${album}`);
});

test('distinguishes preset loading failure from a preparation warning failure', async ({ page }) => {
	const csrf = await authenticateAdministrator(page);
	const preset = graphicsExampleIds[0]!;
	const created = await page.request.post('/api/v1/channels', {
		headers: { 'x-moirai-csrf': csrf },
		data: { number: `graphics-${randomUUID().slice(0, 8)}`, name: 'Graphics test station', graphicsPresetId: preset },
	});
	expect(created.ok()).toBe(true);
	const { id, number } = await created.json();
	try {
		await page.route('**/api/v1/graphics/presets', route => route.abort());
		await page.goto(`/channels/${id}`);
		const editor = page.getByRole('dialog');
		await editor.getByRole('button', { name: /On-screen graphics Show watermarks/ }).click();
		const selector = editor.getByRole('combobox', { name: 'Graphics preset' });
		await expect(selector).toBeDisabled();
		await expect(selector.locator('option:checked')).toHaveText('Graphics presets unavailable');

		await page.unroute('**/api/v1/graphics/presets');
		await page.route(`**/api/v1/channels/${id}/graphics-issue`, route => route.abort());
		await editor.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect(editor.getByText('Graphics preparation status is unavailable.')).toBeVisible();
		await expect(selector).toBeEnabled();
		await expect(selector).toHaveValue(preset);

		const context = await page.request.get(`/api/v1/graphics/preview-context?channelId=${id}&elapsedMs=5000`);
		expect(context.ok()).toBe(true);
		expect(await context.json()).toEqual({
			availability: 'unavailable',
			context: { channel: { name: 'Graphics test station', number }, media: null, now: null, next: null, upcoming: [] },
		});

		await page.goto('/graphics/new');
		const channelPicker = editor.getByRole('combobox', { name: 'Preview channel' });
		await channelPicker.press('ArrowDown');
		const option = editor.getByRole('option', { name: /Graphics test station/ });
		await expect(option).toContainText(number);
		await expect(option.locator('svg')).toBeVisible();
		await channelPicker.press('g');
		await channelPicker.press('Enter');
		await expect(channelPicker).toContainText('Graphics test station');
	}
	finally {
		await page.request.delete(`/api/v1/channels/${id}`, { headers: { 'x-moirai-csrf': csrf } });
	}
});

test('selects a preview channel where its dropdown overlaps the editor footer', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 600 });
	await authenticateAdministrator(page);
	await page.route('**/api/v1/channels', route => route.fulfill({
		json: [{ id: randomUUID(), number: '42', name: 'Graphics test station', logo: null }],
	}));
	await page.goto('/graphics/new');
	const editor = page.getByRole('dialog');
	const picker = editor.getByRole('combobox', { name: 'Preview channel' });
	await picker.click();
	await picker.press('Escape');
	await expect(picker).toHaveAttribute('aria-expanded', 'false');
	await expect(editor).toBeVisible();
	await picker.click();

	const option = editor.getByRole('option', { name: /Graphics test station/ });
	const footer = await editor.locator('.resource-editor-action-bar').boundingBox();
	const bounds = await option.boundingBox();
	const clickY = Math.max(footer!.y, bounds!.y) + 2;
	expect(clickY).toBeLessThan(Math.min(footer!.y + footer!.height, bounds!.y + bounds!.height));
	await option.click({ position: { x: bounds!.width / 2, y: clickY - bounds!.y } });
	await expect(picker).toContainText('Graphics test station');
});

test('keeps wall-clock layers visible in layout and directs timing checks to the rendered frame', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/graphics');
	await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Channel ID', exact: true }) })
		.getByRole('button', { name: 'Duplicate' }).click();
	const editor = page.getByRole('dialog');
	await expect(editor.getByRole('checkbox', { name: 'Show wall-clock layers outside their scheduled times' })).toBeChecked();
	const layer = editor.getByRole('button', { name: 'Select layer 1' });
	await expect(layer).toContainText('Moirai TV');
	const opacity = await layer.evaluate(element => getComputedStyle(element).opacity);
	expect(Number(opacity)).toBeGreaterThan(0.25);
	await editor.getByRole('slider', { name: /Elapsed time/ }).press('End');
	await expect(layer).toHaveCSS('opacity', opacity);
	await expect(editor.getByRole('button', { name: 'Preview', exact: true })).toBeEnabled();
});

test('selects, positions, and reorders layers and previews the resulting draft', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/graphics/new');
	const editor = page.getByRole('dialog');
	const layers = editor.getByRole('region', { name: 'Layers' });
	await addLayer(layers, 'media');
	await addLayer(layers, 'text');
	await layers.getByRole('textbox', { name: 'Text or Liquid template' }).fill('Station identification');
	await layers.getByRole('button', { name: /^2\. / }).click();
	await expect(layers.getByRole('textbox', { name: 'Text or Liquid template' })).toBeHidden();
	await layers.getByRole('button', { name: '1. Text', exact: true }).click();
	const bottomLeft = layers.getByRole('radio', { name: 'bottom left', exact: true });
	await bottomLeft.check();
	await bottomLeft.press('ArrowRight');
	const bottomCenter = layers.getByRole('radio', { name: 'bottom center', exact: true });
	await expect(bottomCenter).toBeChecked();
	await expect(bottomCenter).toBeFocused();
	await expect(bottomCenter.locator('..')).toHaveCSS('outline-style', 'solid');
	await layers.getByRole('button', { name: 'Move lower' }).click();
	await expect(layers.getByRole('button', { name: '2. Text', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await layers.getByRole('button', { name: 'Move higher' }).click();
	await expect(layers.getByRole('button', { name: '1. Text', exact: true })).toHaveAttribute('aria-pressed', 'true');

	await editor.getByRole('button', { name: 'YAML', exact: true }).click();
	const yaml = editor.getByRole('textbox', { name: 'Graphics YAML' });
	await expect(yaml).toHaveValue(/anchor: bottom_center/);
	const source = await yaml.inputValue();
	expect(parse(source).layers.map((layer: { kind: string }) => layer.kind)).toEqual(['media', 'text']);
	await editor.getByRole('button', { name: 'Visual', exact: true }).click();

	await page.route('**/api/v1/graphics/preview', route => route.fulfill({
		path: 'apps/server/assets/graphics-watermark.png', contentType: 'image/png',
	}));
	const slider = editor.getByRole('slider', { name: /Elapsed time/ });
	await slider.press('Home');
	await slider.press('ArrowRight');
	const preview = page.waitForRequest('**/api/v1/graphics/preview');
	await editor.getByRole('button', { name: 'Preview', exact: true }).click();
	expect((await preview).postDataJSON()).toMatchObject({ yaml: source, elapsedMs: 100 });
	await expect(editor.getByRole('img', { name: 'Frame rendered by Next' })).toBeVisible();
	await editor.getByRole('button', { name: 'Edit', exact: true }).click();
	await expect(editor.getByRole('img', { name: 'Frame rendered by Next' })).toBeHidden();
	await expect(editor.getByRole('button', { name: 'Preview', exact: true })).toBeFocused();

	await page.keyboard.press('Escape');
	const confirmation = page.getByRole('alertdialog');
	await expect(confirmation).toBeVisible();
	await page.setViewportSize({ width: 320, height: 700 });
	const footer = confirmation.locator('footer');
	await expect.poll(() => footer.evaluate(element => {
		const { left, right } = element.getBoundingClientRect();
		const buttons = Array.from(element.querySelectorAll('button'));
		const top = buttons[0]?.getBoundingClientRect().top;
		return buttons.length === 3 && buttons.every(button => {
			const bounds = button.getBoundingClientRect();
			return bounds.top === top && bounds.left >= left && bounds.right <= right && button.scrollWidth <= button.clientWidth;
		});
	})).toBe(true);
	await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(layers.getByRole('textbox', { name: 'Text or Liquid template' })).toHaveValue('Station identification');
	await editor.getByRole('button', { name: 'Close graphics preset' }).click();
	await confirmation.getByRole('button', { name: 'Discard', exact: true }).click();
	await expect(editor).toBeHidden();
});

test('uses the available width and keeps the editor inside the viewport', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/graphics/new');
	const editor = page.getByRole('dialog');
	const preview = editor.getByRole('region', { name: 'Preview' });
	const layers = editor.getByRole('region', { name: 'Layers' });
	await addLayer(layers, 'text');
	const canvas = preview.locator('.graphics-canvas');
	const slider = preview.getByRole('slider', { name: /Elapsed time/ });
	const channelPicker = preview.getByRole('combobox', { name: 'Preview channel' });
	const parameters = editor.getByRole('region', { name: 'Preset parameters' });
	const title = editor.locator('header').getByRole('textbox', { name: 'Name' });
	await title.fill('Layout test');
	await expect(editor).toHaveAccessibleName('Layout test');
	const assets = editor.getByText('Manage assets', { exact: true });

	for (const [width, height, scale] of [[1440, 1000, 100], [1440, 600, 100], [390, 844, 100], [320, 844, 100], [320, 844, 200]] as const) {
		await page.setViewportSize({ width: width, height: height });
		const textScale = await page.addStyleTag({ content: `html { font-size: ${scale}% !important; }` });
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		const [dialog, frame, layerPanel, assetPanel] = await Promise.all([
			editor.boundingBox(), canvas.boundingBox(), layers.boundingBox(), assets.boundingBox(),
		]);
		expect(dialog!.y).toBeGreaterThanOrEqual(0);
		expect(dialog!.y + dialog!.height).toBeLessThanOrEqual(height);
		expect(dialog!.width).toBeGreaterThan(width - 64);
		expect(frame!.x).toBeGreaterThanOrEqual(0);
		expect(frame!.x + frame!.width).toBeLessThanOrEqual(width);
		expect(frame!.width / frame!.height).toBeCloseTo(16 / 9, 2);
		const [sliderBox, pickerBox] = await Promise.all([slider.boundingBox(), channelPicker.boundingBox()]);
		expect(sliderBox!.x + sliderBox!.width).toBeLessThanOrEqual(pickerBox!.x);
		expect(Math.abs(sliderBox!.y + sliderBox!.height - pickerBox!.y - pickerBox!.height)).toBeLessThan(1);
		expect(assetPanel!.y).toBeGreaterThanOrEqual(layerPanel!.y + layerPanel!.height);
		if (width > 900) {
			if (height >= 1000) {
				expect(frame!.width).toBeGreaterThan(width / 2);
			}
			expect(frame!.x + frame!.width).toBeLessThan(layerPanel!.x);
		}
		else {
			expect(frame!.y + frame!.height).toBeLessThan(layerPanel!.y);
		}
		const scrollBody = editor.locator('.resource-editor-scroll');
		expect(await scrollBody.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
		const previewStayedPut = await parameters.evaluate((element, previewPanel) => {
			const before = previewPanel!.getBoundingClientRect();
			element.scrollTop = element.scrollHeight;
			const after = previewPanel!.getBoundingClientRect();
			return before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height;
		}, await preview.elementHandle());
		expect(previewStayedPut).toBe(true);
		await expect(assets).toBeInViewport({ ratio: 0.9 });
		expect(await scrollBody.evaluate(element => element.scrollTop)).toBe(0);
		expect(await preview.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
		await expect(preview.getByRole('button', { name: 'Preview', exact: true })).toBeInViewport({ ratio: 0.9 });
		await channelPicker.click();
		await preview.getByRole('option', { name: 'Sample channel' }).click();
		await parameters.evaluate(element => {
			element.scrollTop = 0;
		});
		await expect(title).toBeInViewport({ ratio: 0.9 });
		await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
		await textScale.evaluate(element => element.parentNode?.removeChild(element));
	}
});

test('scrolls the layer list and selected layer settings independently', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 600 });
	await authenticateAdministrator(page);
	await page.goto('/graphics');
	const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Now Playing & Up Next', exact: true }) });
	await card.getByRole('button', { name: 'Duplicate' }).click();
	const editor = page.getByRole('dialog');
	const list = editor.getByRole('region', { name: 'Layer list' });
	const settings = editor.getByRole('region', { name: 'Layer settings' });
	const parameters = editor.getByRole('region', { name: 'Preset parameters' });
	const last = list.getByRole('button', { name: /Now Playing Background/ });
	await expect(last).not.toBeInViewport();
	await last.click();
	await expect(settings.getByLabel('Layer name')).toHaveValue('Now Playing Background');
	const listOffset = await list.evaluate(element => element.scrollTop);
	expect(listOffset).toBeGreaterThan(0);
	const columnOffset = await parameters.evaluate(element => element.scrollTop);

	await settings.focus();
	await settings.press('End');
	await expect(settings.getByText('Reassign attached layers before removing this layer.')).toBeInViewport();
	expect(await settings.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	expect(await list.evaluate(element => element.scrollTop)).toBe(listOffset);
	expect(await parameters.evaluate(element => element.scrollTop)).toBe(columnOffset);
});

test('adds, duplicates, and removes layers from the list footer', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await authenticateAdministrator(page);
	await page.goto('/graphics/new');
	const editor = page.getByRole('dialog');
	const tools = editor.getByRole('group', { name: 'Layer actions' });
	const list = editor.getByRole('region', { name: 'Layer list' });
	const duplicate = tools.getByRole('button', { name: 'Duplicate layer' });
	await expect(duplicate).toBeDisabled();
	await addLayer(editor, 'text');
	const name = editor.getByRole('textbox', { name: 'Layer name' });
	await name.fill('Station ID');
	await name.press('Tab');
	await duplicate.click();
	await expect(list.getByRole('button', { name: '1. Station ID copy' })).toHaveAttribute('aria-pressed', 'true');

	await editor.getByRole('button', { name: 'YAML', exact: true }).click();
	const source = await editor.getByRole('textbox', { name: 'Graphics YAML' }).inputValue();
	const [original, copy] = parse(source).layers;
	expect(copy.id).not.toBe(original.id);
	expect(copy).toEqual({ ...original, id: copy.id, name: 'Station ID copy' });
	await editor.getByRole('button', { name: 'Visual', exact: true }).click();

	await tools.getByRole('button', { name: 'Remove layer', exact: true }).click();
	await expect(list.getByRole('button')).toHaveCount(2);
	await tools.getByRole('button', { name: 'Confirm remove layer' }).click();
	await expect(list.getByRole('button')).toHaveCount(1);
	await expect(list.getByRole('button', { name: '1. Station ID', exact: true })).toBeVisible();
});

test('edits a shape gradient and preserves it through YAML mode', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/graphics/new');
	const editor = page.getByRole('dialog');
	await addLayer(editor, 'shape');
	await editor.getByRole('combobox', { name: /^Type/ }).selectOption('ellipse');
	await editor.getByLabel('Height (px)', { exact: true }).fill('200');
	await editor.getByLabel('Height (px)', { exact: true }).press('Tab');
	await expect(editor.getByRole('combobox', { name: 'Fill mode' })).toHaveValue('solid');
	await editor.getByRole('combobox', { name: 'Fill mode' }).selectOption('gradient');
	await editor.getByLabel('End opacity (%)').fill('25');
	await editor.getByLabel('End opacity (%)').press('Tab');
	await editor.getByRole('button', { name: 'YAML', exact: true }).click();
	await expect(editor.getByRole('textbox', { name: 'Graphics YAML' })).toHaveValue(/primitive: ellipse[\s\S]*height: 200/);
	await editor.getByRole('button', { name: 'Visual', exact: true }).click();
	await expect(editor.getByRole('combobox', { name: /^Type/ })).toHaveValue('ellipse');
	await expect(editor.getByLabel('End opacity (%)')).toHaveValue('25');
	await editor.getByRole('combobox', { name: 'Fill mode' }).selectOption('solid');
	await expect(editor.getByLabel('Fill', { exact: true })).toBeVisible();
	await expect(editor.getByLabel('End opacity (%)')).toHaveCount(0);
});

test('uploads and selects custom media from the layer inspector', async ({ page }) => {
	const csrf = await authenticateAdministrator(page);
	await page.goto('/graphics/new');
	const editor = page.getByRole('dialog');
	await addLayer(editor, 'media');
	const mediaPicker = editor.getByRole('combobox', { name: 'Media', exact: true });
	await mediaPicker.click();
	const animated = editor.getByRole('option', { name: 'Animated sample logo' });
	await expect(animated.locator('img')).toBeVisible();
	await animated.click();
	await expect(mediaPicker).toContainText('Animated sample logo');

	const chooser = page.waitForEvent('filechooser');
	await editor.getByRole('button', { name: 'Upload media' }).click();
	const response = page.waitForResponse(result => result.url().endsWith('/api/v1/graphics/assets') && result.request().method() === 'POST');
	await (await chooser).setFiles('apps/server/assets/graphics-watermark.png');
	const uploaded = await response;
	expect(uploaded.ok()).toBe(true);
	const { id } = await uploaded.json();
	try {
		await expect(editor.getByRole('combobox', { name: 'Media', exact: true }).locator('img')).toHaveAttribute('src', `/api/v1/graphics/assets/${id}`);
		await expect(editor.locator('.graphics-canvas-layer img')).toHaveAttribute('src', `/api/v1/graphics/assets/${id}`);
	}
	finally {
		await page.request.delete(`/api/v1/graphics/assets/${id}`, { headers: { 'x-moirai-csrf': csrf } });
	}
});

test('wraps graphics reference tables and code in narrow in-app help', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 700 });
	await authenticateAdministrator(page);
	await page.goto('/graphics');
	await page.getByRole('button', { name: 'Help with Graphics' }).click();
	const content = page.locator('.help-drawer-content');
	await expect(content.getByRole('table').first()).toBeVisible();
	await expect(content.locator('pre').first()).toBeAttached();
	expect(await content.evaluate(element => element.scrollWidth)).toBe(await content.evaluate(element => element.clientWidth));
});

test('resizes and rotates a layer and anchors text to it', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/graphics/new');
	const editor = page.getByRole('dialog');
	await addLayer(editor, 'shape');
	const width = editor.getByLabel('Width (px)', { exact: true });
	const before = Number(await width.inputValue());
	const resize = editor.getByRole('button', { name: 'Resize layer e', exact: true });
	await resize.press('Shift+ArrowRight');
	const keyboardWidth = Number(await width.inputValue());
	expect(keyboardWidth).toBeGreaterThan(before);
	await resize.hover();
	const edge = (await resize.boundingBox())!;
	await page.mouse.down();
	await page.mouse.move(edge.x + edge.width / 2 + 24, edge.y + edge.height / 2);
	await expect(width).toHaveValue(String(keyboardWidth));
	await page.mouse.up();
	await expect.poll(async () => Number(await width.inputValue())).toBeGreaterThan(keyboardWidth);
	const rotate = editor.getByRole('button', { name: 'Rotate layer' });
	await rotate.scrollIntoViewIfNeeded();
	const handle = await rotate.boundingBox();
	expect(handle).not.toBeNull();
	await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
	await page.mouse.down();
	await page.mouse.move(handle!.x + 45, handle!.y + 15);
	await expect(editor.locator('.graphics-transform-angle')).not.toHaveText('0°');
	await page.keyboard.press('Escape');
	await page.mouse.up();
	await expect(editor.getByLabel('Rotation (°)')).toHaveValue('0');
	await rotate.press('Shift+ArrowRight');
	await expect(editor.getByLabel('Rotation (°)')).toHaveValue('10');
	await editor.getByLabel('Skew X (°)').fill('12');
	await editor.getByLabel('Skew X (°)').press('Tab');
	await editor.getByLabel('Layer name').fill('  Caption background  ');
	await editor.getByLabel('Layer name').press('Tab');
	await expect(editor.getByRole('button', { name: '1. Caption background', exact: true })).toBeVisible();
	await addLayer(editor, 'text');
	await editor.getByLabel('Anchor to').selectOption({ label: 'Layer 2 · Caption background' });
	await editor.getByLabel('Target anchor').selectOption('center_left');
	await editor.getByLabel('Horizontal offset (%)').fill('4');
	await editor.getByLabel('Horizontal offset (%)').press('Tab');
	await editor.getByRole('button', { name: 'YAML', exact: true }).click();
	await expect(editor.getByRole('textbox', { name: 'Graphics YAML' })).toHaveValue(/skewX: 12[\s\S]*rotation: 10[\s\S]*attachment:[\s\S]*offsetX: 4|rotation: 10[\s\S]*skewX: 12[\s\S]*attachment:[\s\S]*offsetX: 4/);
	await editor.getByRole('button', { name: 'Visual', exact: true }).click();
	await expect(editor.getByLabel('Horizontal offset (%)')).toHaveValue('4');
	await editor.getByRole('button', { name: '2. Caption background', exact: true }).click();
	await expect(editor.getByLabel('Layer name')).toHaveValue('Caption background');
	await editor.getByLabel('Layer name').fill('');
	await editor.getByLabel('Layer name').press('Tab');
	await expect(editor.getByRole('button', { name: '2. Shape', exact: true })).toBeVisible();
	await expect(editor.getByText('Reassign attached layers before removing this layer.')).toBeVisible();
	await expect(editor.getByRole('button', { name: 'Remove layer', exact: true })).toBeDisabled();
});

test('uses the latest channel and scrub position for editable Liquid labels', async ({ page }) => {
	await authenticateAdministrator(page);
	const first = { id: randomUUID(), number: '27', name: 'Alpine TV', logo: null };
	const second = { id: randomUUID(), number: '48', name: 'Coastal TV', logo: null };
	await page.route('**/api/v1/channels', route => route.fulfill({ json: [first, second] }));

	let releaseOld!: () => void;
	const oldResponse = new Promise<void>(resolve => {
		releaseOld = resolve;
	});
	let confirmOld!: () => void;
	const oldRequested = new Promise<void>(resolve => {
		confirmOld = resolve;
	});
	const requests: Array<{ channelId: string; elapsed: number }> = [];
	await page.route('**/api/v1/graphics/preview-context?**', async route => {
		const query = new URL(route.request().url()).searchParams;
		const channelId = query.get('channelId')!;
		const elapsed = Number(query.get('elapsedMs'));
		requests.push({ channelId, elapsed });
		const channel = channelId === first.id ? first : second;
		if (channel === first && elapsed === 5000) {
			confirmOld();
			await oldResponse;
		}

		await route.fulfill({ json: {
			availability: elapsed === 8500 ? 'gap' : 'available',
			context: { channel, media: null, now: elapsed === 8500 ? null : { title: `${channel.name} at ${elapsed}` },
				next: null, upcoming: [] },
		} }).catch(() => undefined);
	});

	try {
		await page.goto('/graphics/new');
		const editor = page.getByRole('dialog');
		await addLayer(editor.getByRole('region', { name: 'Layers' }), 'text');
		await editor.getByRole('textbox', { name: 'Text or Liquid template' }).fill('{{ channel.number }} {{ now.title }}');
		const preview = editor.getByRole('region', { name: 'Preview' });
		const canvas = preview.locator('.graphics-canvas');
		const picker = preview.getByRole('combobox', { name: 'Preview channel' });
		await picker.click();
		await editor.getByRole('option', { name: /Alpine TV/ }).click();
		await oldRequested;
		await picker.click();
		await editor.getByRole('option', { name: /Coastal TV/ }).click();
		await expect(canvas).toContainText('48 Coastal TV at 5000');
		releaseOld();

		const slider = preview.getByRole('slider');
		await slider.evaluate((input: HTMLInputElement) => {
			for (const value of ['6100', '6200', '6300']) {
				input.value = value;
				input.dispatchEvent(new Event('input', { bubbles: true }));
			}
		});
		await expect(canvas).toContainText('48 Coastal TV at 6300');
		expect(requests.filter(item => item.channelId === second.id).map(item => item.elapsed)).toEqual([5000, 6300]);

		await slider.evaluate((input: HTMLInputElement) => {
			input.value = '8500';
			input.dispatchEvent(new Event('input', { bubbles: true }));
		});
		await expect(preview.getByRole('status').filter({ hasText: 'Schedule gap' })).toBeVisible();
		await expect(canvas).toContainText('48');
		await expect(canvas).not.toContainText(/Alpine TV|Coastal TV at/);
	}
	finally {
		releaseOld();
	}
});

test('clears graphics when switching to an unassigned channel and resetting its draft', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const ids: string[] = [];
	try {
		const preset = graphicsExampleIds[0]!;
		for (const [name, graphicsPresetId] of [['Assigned station', preset], ['Unassigned station', undefined]] as const) {
			const created = await page.request.post('/api/v1/channels', {
				headers, data: { name, number: `overlay-${randomUUID().slice(0, 8)}`, graphicsPresetId },
			});
			expect(created.ok()).toBe(true);
			const channel = await created.json();
			if (!graphicsPresetId) {
				expect(channel).not.toHaveProperty('graphicsPresetId');
			}
			ids.push(channel.id);
		}

		await page.goto(`/channels/${ids[0]}`);
		const editor = page.getByRole('dialog');
		const summary = editor.getByRole('button', { name: /On-screen graphics Show watermarks/ });
		const selector = editor.getByRole('combobox', { name: 'Graphics preset' });
		await summary.click();
		await expect(selector).toHaveValue(preset);
		await editor.getByRole('button', { name: 'Close channel editor' }).click();

		await page.getByRole('button', { name: 'Edit Unassigned station' }).click();
		if (await summary.getAttribute('aria-expanded') === 'false') {
			await summary.click();
		}
		await expect(selector).toBeEnabled();
		await expect(selector).toHaveValue('');
		await selector.selectOption(preset);
		await editor.getByRole('button', { name: 'Reset', exact: true }).click();
		await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
		await expect(selector).toHaveValue('');
		await expect(editor.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
	}
	finally {
		for (const id of ids) {
			await page.request.delete(`/api/v1/channels/${id}`, { headers });
		}
	}
});

for (const width of [1440, 320]) {
	test(`keeps preview controls in place through rendering and retry at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await page.emulateMedia({ reducedMotion: width === 320 ? 'reduce' : 'no-preference' });
		await authenticateAdministrator(page);
		await page.goto('/graphics/new');
		const editor = page.getByRole('dialog');
		const panel = editor.getByRole('region', { name: 'Preview' });
		const canvas = panel.locator('.graphics-canvas');
		const progress = panel.locator('.graphics-preview-progress');
		const slider = panel.getByRole('slider');
		const action = panel.locator('.graphics-preview-trigger');
		const positions = () => Promise.all([
			canvas, slider, panel.getByRole('combobox', { name: 'Preview channel' }), action,
			panel.locator('.graphics-panel-heading'), panel.locator('.graphics-preview-actions'), editor.locator('.resource-editor-action-bar'),
		].map(locator => locator.boundingBox()));
		await expect(action).toBeEnabled();
		await page.evaluate(() => document.fonts.ready);
		await expect.poll(() => editor.evaluate(element => element.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
		const initial = await positions();

		let release!: () => void;
		const held = new Promise<void>(resolve => {
			release = resolve;
		});
		let attempts = 0;
		await page.route('**/api/v1/graphics/preview', async route => {
			attempts++;
			if (attempts === 1) {
				await held;
			}
			if (attempts === 2 || attempts === 5) {
				await route.fulfill({
					path: 'apps/server/assets/graphics-watermark.png', contentType: 'image/png',
					headers: { 'X-Moirai-Graphics-Warning': 'An attached layer was skipped.' },
				});
				return;
			}
			await route.fulfill({ status: 503, json: {
				code: 'graphics_preview_busy',
				message: attempts === 4 ? 'The renderer is busy. '.repeat(400) : 'The renderer is busy.',
			} });
		});

		try {
			await action.click();
			await expect(progress).toHaveText('Generating preview…');
			await expect(action).toBeDisabled();
			if (width === 320) {
				await expect(progress.locator('.loading-spinner')).toBeHidden();
			}
			else {
				await expect(progress.locator('.loading-spinner')).toBeVisible();
			}
			expect(await positions()).toEqual(initial);
		}
		finally {
			release();
		}

		await expect(progress).toHaveText('Retrying preview…');
		await expect(canvas.getByRole('img', { name: 'Frame rendered by Next' })).toBeVisible();
		await expect(canvas.getByRole('status').filter({ hasText: 'An attached layer was skipped.' })).toBeVisible();
		expect(await positions()).toEqual(initial);

		await action.click();
		await expect(action).toHaveText('Retry');
		const feedback = canvas.getByRole('alert');
		await expect(feedback).toBeVisible();
		await feedback.focus();
		await expect(feedback).toBeFocused();
		expect(await feedback.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
		expect(await positions()).toEqual(initial);

		await action.focus();
		await action.press('Enter');
		await expect(canvas.getByRole('img', { name: 'Frame rendered by Next' })).toBeVisible();
		await expect(action).toHaveText('Preview');
		expect(attempts).toBe(5);
		expect(await positions()).toEqual(initial);

		await action.click();
		await expect(progress).toHaveText('Retrying preview…');
		await slider.press('ArrowRight');
		await expect(progress).toBeEmpty();
		await expect(action).toBeEnabled();
		await page.waitForTimeout(1100);
		expect(attempts).toBe(6);
		await expect(canvas.getByRole('img', { name: 'Frame rendered by Next' })).toBeHidden();
	});
}
