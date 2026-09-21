import { expect, test } from '@playwright/test';
import { installGuideFixture } from './guide-fixture';

test('bounds initial rendering, reaches final rows, and retains keyboard access', async ({ page }) => {
	await installGuideFixture(page, 100);
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(() => {
		let peak = 0;
		new MutationObserver(() => {
			peak = Math.max(peak, document.querySelectorAll('.guide-programme').length);
			Object.assign(window, { peakListings: peak });
		}).observe(document, { childList: true, subtree: true });
	});
	await page.goto('/channels');
	await expect(page.locator('.guide-programme').first()).toBeAttached();
	expect(await page.locator('.guide-channel-cell').count()).toBeLessThan(20);
	expect(await page.evaluate(() => (window as unknown as { peakListings: number }).peakListings)).toBeLessThan(1000);
	await page.locator('.guide-scroll').evaluate(element => {
		element.scrollLeft = element.scrollWidth;
	});
	await expect(page.locator('.guide-row').first().locator('.guide-programme').last()).toHaveAttribute('aria-label', /Programme 335/);
	const firstEdit = page.getByRole('button', { name: 'Edit Synthetic 1', exact: true });
	await firstEdit.focus();
	// Each row ends with its visible programmes; Tab crosses into the next channel's edit action.
	const firstRow = page.locator('.guide-row').filter({ has: firstEdit });
	await firstRow.locator('.guide-programme').last().focus();
	await page.keyboard.press('Tab');
	await expect(page.getByRole('button', { name: 'Edit Synthetic 2', exact: true })).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(firstRow.locator('.guide-programme').last()).toBeFocused();
	await page.locator('.guide-toolbar').click();
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await expect(page.getByRole('button', { name: 'Edit Synthetic 100', exact: true })).toBeVisible();
	expect(await page.locator('.guide-channel-cell').count()).toBeLessThan(20);
	await page.locator('.guide-scroll').evaluate(element => {
		element.scrollLeft = element.scrollWidth;
	});
	await expect(page.locator('.guide-programme').last()).toHaveAttribute('aria-label', /Programme 335/);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.getByRole('button', { name: 'Edit Synthetic 100', exact: true })).toBeVisible();
	await page.waitForTimeout(400);
	await page.screenshot({ path: 'test-results/performance/guide-mobile.png' });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.locator('.primary-nav a[href="/guide"]').click();
	await expect(page.locator('.guide-programme').first()).toBeAttached();
	await page.screenshot({ path: 'test-results/performance/guide-desktop.png' });
	expect(errors).toEqual([]);
});


test('preserves family rows and grouped-listing popover focus', async ({ page }) => {
	await installGuideFixture(page, 20, 6, true);
	await page.goto('/guide');
	await expect(page.locator('.guide-family-cell').first()).toHaveText('1 channels');
	const block = page.locator('.guide-block-copy').first();
	await block.focus();
	const dialog = page.getByRole('dialog', { name: 'Actual guide items' });
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(block).toBeFocused();
	await block.click();
	await expect(dialog).toBeVisible();
	await page.mouse.move(0, 0);
	await page.locator('.guide-scroll').evaluate(element => {
		element.scrollLeft += 300;
	});
	await expect(dialog).toBeHidden();
});


test('keeps artwork, resized rows, and the sticky channel column aligned', async ({ page }) => {
	await installGuideFixture(page, 20, 4, false, true);
	await page.goto('/guide');
	const image = page.locator('.guide-programme-thumb').first();
	await expect(image).toBeVisible();
	await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
	const before = await page.locator('.guide-channel-cell').first().boundingBox();
	await page.locator('.guide-scroll').evaluate(element => {
		element.scrollLeft += 600;
	});
	const after = await page.locator('.guide-channel-cell').first().boundingBox();
	expect(Math.abs(after!.x - before!.x)).toBeLessThan(1);
	await page.setViewportSize({ width: 720, height: 900 });
	await expect(image).toBeAttached();
	const rows = await page.locator('.guide-row').evaluateAll(elements => elements.map(element => {
		const bounds = element.getBoundingClientRect();
		return { top: bounds.top, bottom: bounds.bottom };
	}));
	for (let index = 1; index < rows.length; index++) {
		expect(Math.abs(rows[index]!.top - rows[index - 1]!.bottom)).toBeLessThan(2);
	}
});
