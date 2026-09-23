import { randomUUID } from 'node:crypto';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { installGuideFixture } from './performance/guide-fixture';

const channelId = '00000000-0000-4000-8000-000000000001';

test('retains scheduling refreshes when a channel event follows in the debounce window', async ({ page }) => {
	await installGuideFixture(page, 1, 2);
	let socket: WebSocketRoute | undefined;
	await page.routeWebSocket('**/api/v1/events', ws => {
		socket = ws;
	});
	let reads = 0;
	await page.route('**/api/v1/scheduling/overview', route => {
		reads += 1;
		return route.fulfill({ json: { programs: [], templates: [], channelSchedules: [], programStatuses: [] } });
	});
	await page.goto('/channels');
	await expect(page.getByRole('heading', { name: 'Synthetic 1', exact: true })).toBeVisible();
	await expect.poll(() => Boolean(socket) && reads > 0).toBe(true);
	const before = reads;
	const envelope = { protocolVersion: 1, occurredAt: new Date().toISOString() };
	socket!.send(JSON.stringify({ ...envelope, eventId: randomUUID(), type: 'scheduling.changed', data: { entity: 'assignment', change: 'deleted', id: channelId } }));
	socket!.send(JSON.stringify({ ...envelope, eventId: randomUUID(), type: 'channel.changed', data: { channelId, change: 'updated' } }));
	await expect.poll(() => reads).toBe(before + 1);
	await expect(page.getByText('Updating guide…', { exact: true })).toBeHidden();
});

for (const path of ['/channels', '/guide']) {
	test(`retains populated entries with an actionable failed row on ${path}`, async ({ page }) => {
		await installGuideFixture(page, 1, 2);
		let socket: WebSocketRoute | undefined;
		await page.routeWebSocket('**/api/v1/events', ws => {
			socket = ws;
		});
		await page.goto(path);
		await expect(page.locator('.guide-programme').first()).toBeVisible();
		await expect(page.getByText('Updating guide…', { exact: true })).toBeHidden();
		const entries = await page.locator('.guide-programme').count();
		await page.route('**/api/v1/scheduling/materializations', route => route.fulfill({ json: [{
			channelId, health: 'failed', windowStart: null, windowEnd: null, committedAt: null,
			pendingSince: null, applyAfter: null, lastError: 'Fixture failure',
		}] }));
		await page.route('**/api/v1/schedule-guide?*', route => route.fulfill({ status: 503, json: { message: 'Fixture failure' } }));
		await expect.poll(() => Boolean(socket)).toBe(true);
		socket!.send(JSON.stringify({ protocolVersion: 1, occurredAt: new Date().toISOString(), eventId: randomUUID(),
			type: 'timeline.changed', data: { channelId, status: 'failed' } }));
		const failure = page.locator('.guide-channel-failure');
		await expect(failure.getByRole('alert')).toBeVisible();
		await failure.scrollIntoViewIfNeeded();
		await expect(failure.getByRole('alert')).toBeInViewport();
		await expect(page.locator('.guide-programme')).toHaveCount(entries);
		await page.screenshot({ path: `test-results/retained-guide-failure-${path.slice(1)}.png` });
		await page.unroute('**/api/v1/schedule-guide?*');
		await page.unroute('**/api/v1/scheduling/materializations');
		await failure.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect(failure).toBeHidden();
		await expect(page.locator('.guide-programme').first()).toBeVisible();
	});
}
