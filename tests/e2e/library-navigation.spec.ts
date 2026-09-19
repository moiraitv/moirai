import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('keeps an empty catalog clear of pagination and shows its navigation scan status', async ({ page }) => {
	const csrf = await authenticateAdministrator(page);
	const scanRoot = await mkdtemp(path.join(tmpdir(), 'moirai-library-navigation-'));
	const response = await page.request.post('/api/v1/libraries', {
		headers: { 'x-moirai-csrf': csrf },
		data: {
			name: `Empty library ${Date.now()}`, typeKey: 'movies', sourceType: 'on-disk',
			sourceConfig: { scanRoot, playbackRoot: null },
			enabled: false, watcherEnabled: false, scanIntervalMinutes: 15,
		},
	});
	expect(response.ok()).toBe(true);
	const library = await response.json();
	try {
		await page.goto(`/libraries/${library.id}`);
		await expect(page.locator('.library-nav-link').filter({ hasText: library.name })
			.getByRole('img', { name: /^Scan status:/ })).toBeVisible();
		for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			await expect(page.getByRole('heading', { name: 'No matching media' })).toBeVisible();
			await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
			await expect.poll(async () => {
				const empty = await page.locator('.catalog-results > .empty-state').boundingBox();
				const footer = await page.locator('.catalog-footer').boundingBox();
				return empty && footer ? footer.y - empty.y - empty.height : 0;
			}).toBeGreaterThanOrEqual(20);
		}
	}
	finally {
		await page.request.delete(`/api/v1/libraries/${library.id}`, { headers: { 'x-moirai-csrf': csrf } });
		await rm(scanRoot, { recursive: true, force: true });
	}
});
