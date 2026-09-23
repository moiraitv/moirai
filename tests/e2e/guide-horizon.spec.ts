import { randomUUID } from 'node:crypto';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { installGuideFixture } from './performance/guide-fixture';

for (const width of [1440, 390]) {
	for (const guideDays of [3, 14]) {
		test(`bounds the ${guideDays}-day guide at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await installGuideFixture(page, 1, 2);
			await page.route('**/api/v1/capabilities', route => route.fulfill({ json: {
				timeZone: 'UTC', publicUrl: 'http://localhost', publicUrlStatus: 'configured', guideDays,
			} }));
			const requestedDays: number[] = [];
			page.on('request', request => {
				const url = new URL(request.url());
				if (url.pathname.endsWith('/schedule-guide')) {
					requestedDays.push(Number(url.searchParams.get('days')));
				}
			});
			await page.goto('/guide');
			await expect(page.getByText(`A committed rolling ${guideDays}-day guide`, { exact: false })).toBeVisible();
			await expect(page.locator('.guide-programme').first()).toBeVisible();
			await expect.poll(() => requestedDays.includes(Math.min(7, guideDays))).toBe(true);
			const next = page.getByRole('button', { name: 'Next week', exact: true });
			if (guideDays > 7) {
				await expect(next).toBeEnabled();
				await next.click();
				await expect(page.getByRole('button', { name: 'Previous week', exact: true })).toBeEnabled();
			}
			await expect(next).toBeDisabled();
			expect(requestedDays.every(days => days <= guideDays)).toBe(true);
		});
	}
}

for (const route of ['/guide', '/channels']) {
	test(`reloads the horizon before refreshing ${route} after reconnect`, async ({ page }) => {
		await installGuideFixture(page, 1, 2);
		let socket: WebSocketRoute | undefined;
		await page.routeWebSocket('**/api/v1/events', connection => {
			socket = connection; 
		});
		let horizon = 7;
		let capabilityReads = 0;
		await page.route('**/api/v1/capabilities', request => {
			capabilityReads += 1;
			return request.fulfill({ json: { timeZone: 'UTC', publicUrl: 'http://localhost', publicUrlStatus: 'configured', guideDays: horizon } });
		});
		const guideReads: number[] = [];
		let invalidReads = 0;
		await page.route('**/api/v1/schedule-guide?*', async request => {
			const days = Number(new URL(request.request().url()).searchParams.get('days'));
			guideReads.push(days);
			if (days > horizon) {
				invalidReads += 1;
				await request.fulfill({ status: 422, json: { message: 'Outside committed range' } });
				return;
			}
			await request.fallback();
		});
		await page.goto(route);
		await expect(page.locator('.guide-programme').first()).toBeVisible();
		await expect.poll(() => socket !== undefined && guideReads.includes(7)).toBe(true);
		const previousCapabilities = capabilityReads;
		horizon = 3;
		guideReads.length = 0;
		socket!.send(JSON.stringify({ protocolVersion: 1, eventId: randomUUID(), occurredAt: new Date().toISOString(),
			type: 'system.ready', data: { connectionId: randomUUID() } }));
		// A following event must not erase the pending capability refresh during debounce.
		socket!.send(JSON.stringify({ protocolVersion: 1, eventId: randomUUID(), occurredAt: new Date().toISOString(),
			type: 'channel.changed', data: { channelId: '00000000-0000-4000-8000-000000000001', change: 'updated' } }));
		await expect.poll(() => guideReads.includes(3)).toBe(true);
		expect(capabilityReads).toBeGreaterThan(previousCapabilities);
		expect(invalidReads).toBe(0);
		await expect(page.getByRole('button', { name: 'Next week', exact: true })).toBeDisabled();
	});
}
