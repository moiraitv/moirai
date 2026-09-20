import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('preserves catalog scroll, filters and pagination when closing a Program editor', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const ids: string[] = [];
	try {
		for (let index = 0; index < 24; index += 1) {
			const response = await page.request.post('/api/v1/programs', { headers, data: {
				name: `Scroll fixture ${String(index).padStart(2, '0')}`, config: { type: 'content',
					source: { type: 'library-query', libraryId: randomUUID() }, strategy: { type: 'sequential' } },
			} });
			expect(response.ok()).toBe(true);
			ids.push((await response.json()).id);
		}
		await page.goto('/schedules/programs?q=Scroll&page=2&pageSize=10');
		const opener = page.locator('.program-row').last().getByRole('link').first();
		await expect(page.locator('.program-row')).toHaveCount(10);
		await opener.scrollIntoViewIfNeeded();
		const position = await page.evaluate(() => window.scrollY);
		expect(position).toBeGreaterThan(100);
		await opener.click();
		await expect(page.getByRole('dialog', { name: 'Edit Program' })).toBeVisible();
		await page.getByRole('button', { name: 'Close program editor' }).click();
		await expect(page.getByRole('dialog')).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(position);
		expect(new URL(page.url()).searchParams.get('page')).toBe('2');
		expect(new URL(page.url()).searchParams.get('q')).toBe('Scroll');
		await expect(opener).toBeFocused();
		await opener.click();
		await expect(page.getByRole('dialog', { name: 'Edit Program' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(position);
	}
	finally {
		for (const id of ids) {
			await page.request.delete(`/api/v1/programs/${id}`, { headers });
		}
	}
});
