import { expect, test } from '@playwright/test';
import { MAX_GUIDE_TIMELINE_SEGMENTS } from '@moirai/shared';
import { installGuideFixture } from './guide-fixture';
import { saveProfile } from './profile-output';

// Trace snapshots traverse the whole DOM and distort browser CPU measurements.
test.use({ trace: 'off' });

test('profiles synthetic guide navigation and retained browser resources', async ({ page }, testInfo) => {
	const channelCount = Number(process.env.GUIDE_CHANNELS ?? 20);
	const segmentsPerDay = process.env.GUIDE_NEAR_LIMIT ? Math.floor(MAX_GUIDE_TIMELINE_SEGMENTS / channelCount / 7) : Number(process.env.GUIDE_SEGMENTS_PER_DAY ?? 48);
	await installGuideFixture(page, channelCount, segmentsPerDay);
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	const session = await page.context().newCDPSession(page);
	await session.send('Performance.enable');
	await session.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.GUIDE_CPU_RATE ?? 1) });
	await page.addInitScript(() => {
		const tasks: number[] = [];
		Object.assign(window, { guideLongTasks: tasks });
		new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration)))
			.observe({ type: 'longtask', buffered: true });
	});
	const samples: unknown[] = [];
	const retained: unknown[] = [];
	const coldStart = performance.now();
	const initialWeek = page.waitForResponse(response => response.url().includes('/schedule-guide?') && new URL(response.url()).searchParams.get('days') === '7');
	await page.goto('/guide');
	await expect(page.locator('.guide-programme').first()).toBeVisible();
	const coldPaint = performance.now() - coldStart;
	await (await initialWeek).finished();
	await page.waitForTimeout(1000);
	for (const path of ['/channels', '/guide', '/channels', '/guide', '/channels', '/guide']) {
		const before = await session.send('Performance.getMetrics');
		const start = performance.now();
		const refreshed = page.waitForResponse(response => response.url().includes('/schedule-guide?') && new URL(response.url()).searchParams.get('days') === '7');
		await page.locator(`.primary-nav a[href="${path}"]`).click();
		await expect(page).toHaveURL(new RegExp(`${path}$`));
		await expect(page.locator('.guide-programme').first()).toBeAttached();
		await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const elapsed = performance.now() - start;
		await (await refreshed).finished();
		await page.waitForTimeout(500);
		const after = await session.send('Performance.getMetrics');
		const delta = Object.fromEntries(after.metrics.filter(metric => ['TaskDuration', 'ScriptDuration', 'LayoutDuration'].includes(metric.name))
			.map(metric => [metric.name, (metric.value - (before.metrics.find(prior => prior.name === metric.name)?.value ?? 0)) * 1000]));
		samples.push({ path, elapsed, ...delta, listings: await page.locator('.guide-programme').count(), rows: await page.locator('.guide-channel-cell').count() });
		if (path === '/guide') {
			await session.send('HeapProfiler.collectGarbage');
			retained.push({ dom: await session.send('Memory.getDOMCounters'), heap: await session.send('Runtime.getHeapUsage') });
		}
	}
	const exitStart = performance.now();
	await page.locator('.primary-nav a[href="/libraries"]').click();
	await expect(page.locator('.guide-frame')).toHaveCount(0);
	const exitTime = performance.now() - exitStart;
	await session.send('HeapProfiler.collectGarbage');
	const afterExit = { dom: await session.send('Memory.getDOMCounters'), heap: await session.send('Runtime.getHeapUsage') };
	const metrics = await session.send('Performance.getMetrics');
	const tasks = await page.evaluate(() => (window as unknown as { guideLongTasks: number[] }).guideLongTasks);
	await saveProfile(testInfo, 'guide-profile', { coldPaint, exitTime, channelCount, segmentsPerDay, samples, retained, afterExit, tasks, metrics, errors });
	console.log(JSON.stringify({ coldPaint, exitTime, samples, retained, afterExit, longTasks: tasks, errors }));
	expect(errors).toEqual([]);
});
