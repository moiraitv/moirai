import { expect, test } from '@playwright/test';
import { installGuideFixture } from './guide-fixture';
import { saveProfile } from './profile-output';

// Trace snapshots traverse the whole DOM and distort browser CPU measurements.
test.use({ trace: 'off' });

test('profiles accumulated log pages and refresh rendering', async ({ page }, testInfo) => {
	await installGuideFixture(page, 1);
	// Keep the five-second refresh from replacing accumulated pages during this pagination profile.
	await page.addInitScript(() => {
		const interval = window.setInterval.bind(window);
		window.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
			interval(callback, delay === 5000 ? 60000 : delay, ...args)) as typeof window.setInterval;
	});
	await page.route('**/api/v1/logs?*', async route => {
		const offset = Number(new URL(route.request().url()).searchParams.get('cursor') ?? 0);
		await route.fulfill({ json: {
			entries: Array.from({ length: 100 }, (_, index) => ({
				id: String(offset + index), time: new Date(Date.UTC(2026, 8, 20, 12, 0, offset + index)).toISOString(),
				level: 'info', message: `Synthetic log ${offset + index}`, context: {}, requestId: null,
			})), nextCursor: offset < 900 ? String(offset + 100) : null, scanLimitReached: false,
		} });
	});
	const session = await page.context().newCDPSession(page);
	await session.send('Performance.enable');
	await page.goto('/logs');
	await expect(page.locator('.log-entry')).toHaveCount(100);
	const samples = [];
	for (let count = 200; count <= 1000; count += 100) {
		const before = await session.send('Performance.getMetrics');
		const start = performance.now();
		await page.locator('.logs-load-more button').click();
		await expect(page.locator('.log-entry')).toHaveCount(count);
		await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const after = await session.send('Performance.getMetrics');
		samples.push({ count, elapsed: performance.now() - start, task: 1000 * ((after.metrics.find(m => m.name === 'TaskDuration')?.value ?? 0) - (before.metrics.find(m => m.name === 'TaskDuration')?.value ?? 0)) });
	}
	console.log(JSON.stringify({ logs: samples }));
	await saveProfile(testInfo, 'logs-profile', samples);
});
