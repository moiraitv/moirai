import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('preserves catalog scroll, filters and selection when closing a Program editor', async ({ page }) => {
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
		const list = page.locator('.program-management-list');
		await expect(list).toBeVisible();
		await list.evaluate(element => {
			element.scrollTop = element.scrollHeight;
		});
		const opener = page.getByRole('button', { name: /^Scroll fixture 23/ });
		await expect(opener).toBeVisible();
		const position = await list.evaluate(element => element.scrollTop);
		expect(position).toBeGreaterThan(0);
		await opener.click();
		await page.getByRole('link', { name: 'Edit Program', exact: true }).click();
		await expect(page.getByRole('dialog', { name: 'Edit Program' })).toBeVisible();
		await page.getByRole('button', { name: 'Close program editor' }).click();
		await expect(page.getByRole('dialog', { name: 'Edit Program' })).toBeHidden();
		await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(position);
		expect(new URL(page.url()).searchParams.get('page')).toBeNull();
		expect(new URL(page.url()).searchParams.get('q')).toBe('Scroll');
		expect(new URL(page.url()).searchParams.get('selected')).toBe(ids[23]);
		await page.getByRole('button', { name: 'Close program inspector' }).click();
		await expect(opener).toBeFocused();

	}
	finally {
		for (const id of ids) {
			await page.request.delete(`/api/v1/programs/${id}`, { headers });
		}
	}
});
