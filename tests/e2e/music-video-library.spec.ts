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
	}
	finally {
		if (libraryId) {
			await page.request.delete(`/api/v1/libraries/${libraryId}`, { headers });
		}
		await rm(root, { recursive: true, force: true });
	}
});
