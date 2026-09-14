import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('shows complete content labels and progress on compact Status cards', async ({ page }) => {
	await authenticateAdministrator(page);
	const titles = ['A Movie', 'Space Station · S2E5 · First Contact with a Distant Civilization', 'Example Artist, Guest Artist · Opening Song'];
	const now = Date.now();
	await page.route('**/api/v1/playback/status', async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		await route.fulfill({ response, json: {
			...body, activeSessionCount: titles.length,
			sessions: titles.map((title, index) => ({
				channelId: randomUUID(), channelNumber: String(index + 1), channelName: ['Movies', 'Shows', 'Music'][index],
				state: 'ready', startedAt: new Date(now - 60_000).toISOString(), pid: null, lastError: null, acceleration: 'none', clients: [],
				nowPlaying: { title, artworkUrl: null, startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + 60_000).toISOString() },
			})),
		} });
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	const labels = page.locator('.playback-now-playing-copy > strong');
	await expect(labels).toHaveText(titles);
	for (const label of await labels.all()) {
		await expect(label).toHaveCSS('white-space', 'normal');
		expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	}
	await expect(page.getByRole('progressbar', { name: 'Current program position' })).toHaveCount(3);
	await page.screenshot({ path: 'test-results/now-playing-mobile.png', fullPage: true });
});
