import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { SECONDS_PER_SCHEDULING_DAY, type ScheduleGuide, type TimelineSegment } from '@moirai/shared';
import { authenticateAdministrator } from './authentication';

/** Compare playback identity and timing independently of item-mode presentation enrichment. */
function playbackFields(segment: TimelineSegment): Record<string, unknown> {
	const presentation = new Set(['title', 'subtitle', 'posterUrl', 'landscapeUrl', 'fanartUrl']);
	return Object.fromEntries(Object.entries(segment).filter(([key]) => !presentation.has(key)));
}

test('saves a guide block without changing playback and exposes actual items on desktop and touch', async ({ page }) => {
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const channelResponse = await page.request.post('/api/v1/channels', { headers, data: { number: '99.8', name: 'Slot Guide' } });
	expect(channelResponse.ok()).toBe(true);
	const channel = await channelResponse.json();
	await page.route('**/api/v1/channels', route => route.fulfill({ json: [channel] }));
	const slotId = randomUUID();
	const response = await page.request.post('/api/v1/schedule-templates', {
		headers, data: {
			name: `Guide ${randomUUID()}`, slots: [{ id: slotId, startSeconds: 0, programId: null, filler: { mode: 'disabled' } }],
			boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard' }],
		},
	});
	expect(response.ok()).toBe(true);
	const template = await response.json();
	const assigned = await page.request.put(`/api/v1/channels/${channel.id}/schedule`, { headers, data: { defaultTemplateId: template.id } });
	expect(assigned.ok()).toBe(true);
	const beforeResponse = await page.request.get('/api/v1/schedule-guide');
	expect(beforeResponse.ok()).toBe(true);
	const before = await beforeResponse.json() as ScheduleGuide;
	const original = before.channels.find((entry) => entry.channelId === channel.id)!.preview.segments.map(playbackFields);
	// Prime the XMLTV cache before making a presentation-only edit.
	expect((await page.request.get(`http://127.0.0.1:${process.env.MOIRAI_E2E_API_PORT ?? '3008'}/epg.xml`)).ok()).toBe(true);
	await page.goto(`/schedules/templates/${template.id}`);
	await page.getByRole('combobox', { name: 'Show in guide' }).selectOption('block');
	const save = page.getByRole('button', { name: 'Save', exact: true });
	await expect(save).toBeEnabled();
	await save.click();
	await expect(page.getByRole('dialog', { name: 'Template editor', exact: true })).toBeHidden();
	await page.goto(`/schedules/templates/${template.id}`);
	await expect(save).toBeDisabled();
	const defaultGuide = await (await page.request.get('/api/v1/schedule-guide')).json() as ScheduleGuide;
	expect(defaultGuide.channels.find((entry) => entry.channelId === channel.id)!.entries?.some((entry) =>
		entry.kind === 'block' && entry.title === 'No programming')).toBe(true);
	await page.getByRole('textbox', { name: 'Guide title', exact: true }).fill('Rock Music');
	await page.getByRole('textbox', { name: 'Guide description (optional)' }).fill('A full day of rock');
	await expect(save).toBeEnabled();
	const previewBlock = page.locator('.resolved-track').getByRole('button', { name: /Rock Music/ }).first();
	await expect(previewBlock).toBeVisible();
	await previewBlock.focus();
	const previewItems = page.getByRole('dialog', { name: 'Actual guide items' });
	await expect(previewItems).toBeVisible();
	await expect(previewItems.getByText('No programming', { exact: true }).first()).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(previewItems).not.toBeVisible();
	await expect(previewBlock).toBeFocused();
	const previewBounds = await previewBlock.boundingBox();
	await previewBlock.hover({ position: { x: previewBounds!.width * 0.25, y: previewBounds!.height / 2 } });
	await expect(previewItems).toBeVisible();
	await expect(previewItems.getByRole('button', { name: 'Close guide items' })).toHaveCount(0);
	const marker = page.locator('.guide-position-marker');
	await expect(marker).toBeVisible();
	const crop = previewItems.locator('.guide-crop');
	expect(Number(await crop.getAttribute('data-finish')) - Number(await crop.getAttribute('data-start'))).toBe(30 * 60_000);
	await expect(page.locator('.guide-range-marker')).toHaveCount(2);
	await expect(marker.locator('svg')).toHaveCount(0);
	const earlierCenter = Number(await crop.getAttribute('data-center'));
	await page.mouse.move(previewBounds!.x + previewBounds!.width * 0.75, previewBounds!.y + previewBounds!.height / 2);
	await expect.poll(async () => Number(await crop.getAttribute('data-center'))).toBeGreaterThan(earlierCenter);
	const pointerX = previewBounds!.x + previewBounds!.width * 0.75;
	await expect.poll(async () => Math.abs((await marker.boundingBox())!.x - pointerX)).toBeLessThan(2);
	const panelBounds = (await previewItems.boundingBox())!;
	const expectedLeft = Math.max(8, Math.min(pointerX - panelBounds.width / 2, page.viewportSize()!.width - panelBounds.width - 8));
	expect(Math.abs(panelBounds.x - expectedLeft)).toBeLessThan(2);
	await expect(previewItems.getByRole('group', { name: 'Actual items timeline' })).toBeVisible();
	await expect(previewItems.locator('ul')).toHaveCount(0);
	await previewBlock.click();
	await expect(previewItems).toBeVisible();
	await expect(previewItems).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(previewItems.getByRole('button', { name: 'Close guide items' })).toBeFocused();
	await previewItems.getByRole('button', { name: 'Close guide items' }).click();
	await expect(previewBlock).toBeFocused();
	await expect(page.getByRole('textbox', { name: 'Guide title', exact: true })).toHaveValue('Rock Music');
	await expect(save).toBeEnabled();
	await save.click();
	await expect(page.getByRole('dialog', { name: 'Template editor', exact: true })).toBeHidden();
	await page.goto(`/schedules/templates/${template.id}`);
	await expect(save).toBeDisabled();
	await expect(page.getByRole('textbox', { name: 'Guide title', exact: true })).toHaveValue('Rock Music');
	const afterResponse = await page.request.get('/api/v1/schedule-guide');
	const after = await afterResponse.json() as ScheduleGuide;
	expect(after.channels.find((entry) => entry.channelId === channel.id)!.preview.segments.map(playbackFields)).toEqual(original);
	expect(after.channels.find((entry) => entry.channelId === channel.id)!.entries?.some((entry) => entry.title === 'Rock Music')).toBe(true);
	const xml = await (await page.request.get(`http://127.0.0.1:${process.env.MOIRAI_E2E_API_PORT ?? '3008'}/epg.xml`)).text();
	expect(xml).toContain('<title>Rock Music</title>');
	expect(xml).toContain('<desc>A full day of rock</desc>');
	await page.goto('/guide');
	const block = page.getByRole('button', { name: /Rock Music/ }).first();
	await page.locator('.guide-scroll').evaluate((element) => {
		element.scrollLeft = 1000;
	});
	const labelBounds = await block.boundingBox();
	const scrollBounds = await page.locator('.guide-scroll').boundingBox();
	expect(labelBounds!.x).toBeGreaterThanOrEqual(scrollBounds!.x);
	expect(labelBounds!.x + labelBounds!.width).toBeLessThanOrEqual(scrollBounds!.x + scrollBounds!.width);
	const popover = page.getByRole('dialog', { name: 'Actual guide items' });
	await block.hover();
	await expect(popover).toBeVisible();
	await page.screenshot({ path: 'test-results/slot-guide-hover.png' });
	await expect(popover.getByRole('button', { name: /No programming/ })).toBeVisible();
	await expect(popover.getByRole('button', { name: 'Close guide items' })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(popover).not.toBeVisible();
	await block.blur();
	await block.focus();
	await expect(popover).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(popover).not.toBeVisible();
	await expect(block).toBeFocused();
	await block.click();
	await expect(popover).toBeVisible();
	await expect(popover.getByRole('button', { name: 'Close guide items' })).toBeVisible();
	// Scrolling within the preview must not dismiss it; moving its guide invalidates the anchor.
	await popover.evaluate(async (element) => {
		(element as HTMLElement).style.maxHeight = '100px';
		element.scrollTop = 40;
		await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	});
	expect(await popover.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await expect(popover).toBeVisible();
	await popover.evaluate(element => {
		(element as HTMLElement).style.maxHeight = ''; 
	});
	await page.locator('.guide-scroll').evaluate(element => {
		element.scrollLeft += 200; 
	});
	await expect(popover).not.toBeVisible();
	await expect(page.locator('.guide-position-marker, .guide-range-marker')).toHaveCount(0);
	await block.click();
	await expect(popover).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(popover).not.toBeVisible();
	expect(pageErrors).toEqual([]);
	await block.click();
	await expect(popover).toBeVisible();
	await expect(popover.getByRole('button', { name: 'Close guide items' })).toBeVisible();
	const bounds = await popover.boundingBox();
	expect(bounds!.x).toBeGreaterThanOrEqual(0);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
	await page.screenshot({ path: 'test-results/slot-guide-mobile.png' });
	await popover.getByRole('button', { name: /No programming/ }).click();
	await expect(popover).not.toBeVisible();
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.goto(`/schedules/channels/${channel.id}`);
	const scheduleEditor = page.getByRole('dialog', { name: 'Channel schedule editor' });
	const scheduleBlock = scheduleEditor.locator('.resolved-track').getByRole('button', { name: /Rock Music/ }).first();
	await scheduleBlock.focus();
	await page.keyboard.press('Enter');
	await expect(previewItems).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(previewItems.getByRole('button', { name: 'Close guide items' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(previewItems).toBeHidden();
	await expect(scheduleBlock).toBeFocused();
	await expect(scheduleEditor).toBeVisible();
	await scheduleBlock.click();
	await previewItems.getByRole('button', { name: 'Close guide items' }).click();
	await expect(previewItems).toBeHidden();
	await expect(scheduleBlock).toBeFocused();
});

test('Today recenters the current guide window on both pages', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const created = await page.request.post('/api/v1/channels', {
		headers, data: { number: '99.9', name: 'Today navigation' },
	});
	expect(created.ok()).toBe(true);
	await page.setViewportSize({ width: 1280, height: 720 });

	for (const url of ['/guide', '/channels']) {
		await page.goto(url);
		const scroller = page.locator('.guide-scroll');
		const now = page.locator('.guide-time-header .current-time-line');
		await expect(now).toBeAttached();
		await scroller.evaluate(element => {
			element.scrollLeft = element.scrollWidth;
		});
		await page.getByRole('button', { name: 'Today', exact: true }).click();
		await expect.poll(() => scroller.evaluate(element => {
			const line = element.closest('.guide-frame')!.querySelector<HTMLElement>('.guide-time-header .current-time-line')!;
			const column = element.closest('.guide-frame')!.querySelector<HTMLElement>('.guide-corner')!;
			const target = Number.parseFloat(line.style.left);
			const expected = Math.max(0, target - (element.clientWidth - column.offsetWidth) / 2);
			return Math.abs(element.scrollLeft - expected);
		})).toBeLessThan(1);
	}
});

test('opens the channel editor from the full identity cell and keyboard', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const response = await page.request.post('/api/v1/channels', {
		headers, data: { number: '99.7', name: 'Full cell edit' },
	});
	expect(response.ok()).toBe(true);
	const channel = await response.json();
	await page.route('**/api/v1/channels', route => route.fulfill({ json: [channel] }));
	try {
		await page.goto('/channels');
		const cell = page.locator('.guide-channel-cell').filter({ hasText: 'Full cell edit' });
		const dialog = page.getByRole('dialog', { name: /channel/i });
		for (const width of [1280, 390]) {
			await page.setViewportSize({ width, height: 800 });
			await cell.scrollIntoViewIfNeeded();
			const bounds = await cell.boundingBox();
			expect(bounds).not.toBeNull();
			await page.mouse.click(bounds!.x + 5, bounds!.y + 5);
			await expect(dialog).toBeVisible();
			await page.getByRole('button', { name: 'Close channel editor' }).click();
		}
		await cell.getByRole('button', { name: 'Edit Full cell edit' }).focus();
		await page.keyboard.press('Enter');
		await expect(dialog).toBeVisible();
	}
	finally {
		await page.request.delete(`/api/v1/channels/${channel.id}`, { headers });
	}
});
