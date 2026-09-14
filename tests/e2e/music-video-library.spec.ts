import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';
import { waitForLibraryScan } from './library-scan';

test('browses music videos through artist and album cards with navigable breadcrumbs', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-music-browser-'));
	let libraryId: string | undefined;
	try {
		await writeFile(path.join(root, 'Song.mp4'), 'fixture');
		await writeFile(path.join(root, 'Song.nfo'), '<musicvideo><title>Opening Song</title><artist>Example Artist</artist><album>Evening Sessions</album></musicvideo>');
		const response = await page.request.post('/api/v1/libraries', {
			headers,
			data: { name: 'Music hierarchy', typeKey: 'music-videos', sourceType: 'on-disk', sourceConfig: { scanRoot: root }, watcherEnabled: false },
		});
		expect(response.ok()).toBe(true);
		libraryId = (await response.json()).id;
		await waitForLibraryScan(page, libraryId!);
		await page.goto(`/libraries/${libraryId}`);
		const cards = page.locator('.media-card');
		await expect(cards).toHaveCount(1);
		await expect(cards.first()).toContainText('Example Artist');
		await expect(cards.first()).toContainText('1 album');
		await cards.first().click();
		await expect(cards).toHaveCount(1);
		await expect(cards.first()).toContainText('Evening Sessions');
		await expect(cards.first()).toContainText('1 song');
		await cards.first().click();
		await expect(cards).toHaveCount(1);
		await expect(cards.first()).toContainText('Opening Song');
		await page.screenshot({ path: 'test-results/music-video-library.png' });
		await page.goBack();
		await expect(cards.first()).toContainText('Evening Sessions');
		await page.reload();
		await expect(cards.first()).toContainText('Evening Sessions');
		await page.goBack();
		await expect(cards.first()).toContainText('Example Artist');

		for (const width of [1440, 390]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`/libraries/${libraryId}?q=Example`);
			await expect(cards.first()).toContainText('Opening Song');
			const explanation = cards.first().locator('.media-card-match');
			await expect(explanation).toContainText('Matched Artist · Example Artist');
			await expect(explanation).toHaveAttribute('title', 'Matched Artist · Example Artist');
			await expect.poll(() => explanation.evaluate(element => element.getBoundingClientRect().bottom <= element.closest('.media-card')!.getBoundingClientRect().bottom)).toBe(true);
			await page.getByRole('button', { name: 'Filter media', exact: true }).click();
			const filters = page.getByRole('dialog', { name: 'Filter media' });
			await expect(filters.getByLabel('Artist', { exact: true })).toBeVisible();
			await filters.getByLabel('Album', { exact: true }).fill('Evening');
			await filters.getByPlaceholder('Partial title').fill('Opening');
			await filters.getByRole('button', { name: 'Apply Filters' }).click();
			await expect(page).toHaveURL(/q=Example/);
			await expect(page).toHaveURL(/name=Opening/);
			await expect(cards.first()).toContainText('Opening Song');
		}
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/schedules/programs/new');
		await page.getByLabel('Library', { exact: true }).selectOption(libraryId!);
		await page.getByRole('button', { name: 'Configure Filters' }).click();
		let filters = page.getByRole('dialog', { name: 'Filter media' });
		await expect(filters.getByLabel('Artist', { exact: true })).toBeVisible();
		await expect(filters.getByLabel('Album', { exact: true })).toBeVisible();
		await filters.getByRole('button', { name: 'Cancel', exact: true }).click();
		await page.goto('/quick');
		await page.getByRole('button', { name: /Music.*Channel/ }).click();
		await page.getByRole('combobox', { name: /^Library/ }).selectOption(libraryId!);
		await page.locator('#quick-setup-actions').getByRole('button', { name: 'Continue', exact: true }).click();
		await page.getByRole('button', { name: 'Configure Filters' }).click();
		filters = page.getByRole('dialog', { name: 'Filter media' });
		await expect(filters.getByLabel('Artist', { exact: true })).toBeVisible();
		await expect(filters.getByLabel('Album', { exact: true })).toBeVisible();

	}
	finally {
		if (libraryId) {
			await page.request.delete(`/api/v1/libraries/${libraryId}`, { headers });
		}
		await rm(root, { recursive: true, force: true });
	}
});
