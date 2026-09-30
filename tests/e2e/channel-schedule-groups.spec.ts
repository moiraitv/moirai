import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('groups schedule cards by channel number after search filtering', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const family = String(1000 + Math.floor(Math.random() * 8000));
	const marker = randomUUID();
	for (const [suffix, name] of [['10', 'Beta'], ['2', 'Alpha']]) {
		const response = await page.request.post('/api/v1/channels', {
			headers,
			data: { number: `${family}.${suffix}`, name: `${marker} ${name}` },
		});
		expect(response.ok(), await response.text()).toBe(true);
	}

	await page.goto('/schedules/channels');
	const search = page.getByRole('searchbox', { name: 'Search channels' });
	await search.fill(marker);
	await expect(page.getByRole('heading', { name: `${family} channels` })).toBeVisible();
	await expect(page.locator('.schedule-channel-card .schedule-channel-title')).toHaveText([
		`${family}.2·${marker} Alpha`,
		`${family}.10·${marker} Beta`,
	]);

	await search.fill(`${marker} Alpha`);
	await expect(page.getByRole('heading', { name: `${family} channels` })).toHaveCount(0);
	await expect(page.locator('.schedule-channel-card')).toHaveCount(1);
});
