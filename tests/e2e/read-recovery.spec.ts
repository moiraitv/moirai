import { randomUUID } from 'node:crypto';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

for (const resource of [
	{ path: 'encoding-profiles', add: 'New Profile', name: 'Recovered profile' },
	{ path: 'credit-templates', add: 'New template', name: 'Recovered credits' },
]) {
	test(`recovers ${resource.path} after the initial list request fails and a new resource is saved`, async ({ page }) => {
		const csrf = await authenticateAdministrator(page);
		let first = true;
		await page.route(`**/api/v1/${resource.path}`, async route => {
			if (first && route.request().method() === 'GET') {
				first = false;
				await route.fulfill({ status: 503, json: { message: 'Initial list unavailable' } });
			}
			else {
				await route.continue();
			}
		});
		await page.goto(`/playback/${resource.path}`);
		await expect(page.getByText('Initial list unavailable')).toBeVisible();
		await page.getByRole('button', { name: resource.add, exact: true }).click();
		const editor = page.getByRole('dialog');
		const name = `${resource.name} after initial failure`;
		await editor.getByLabel('Name', { exact: true }).fill(name);
		const savedResponse = page.waitForResponse(response => response.url().endsWith(`/api/v1/${resource.path}`) && response.request().method() === 'POST');
		await editor.getByRole('button', { name: 'Save', exact: true }).click();
		const saved = await (await savedResponse).json();
		await expect(editor).toBeHidden();
		await expect(page.getByRole('button', { name: resource.add, exact: true })).toBeEnabled();
		await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
		await expect(page.getByText('Initial list unavailable')).toBeHidden();
		await page.request.delete(`/api/v1/${resource.path}/${saved.id}`, { headers: { 'x-moirai-csrf': csrf } });
	});

	test(`retains saved ${resource.path} when both follow-up reads fail`, async ({ page }) => {
		const csrf = await authenticateAdministrator(page);
		await page.goto(`/playback/${resource.path}`);
		await page.getByRole('button', { name: resource.add, exact: true }).click();
		const editor = page.getByRole('dialog');
		await editor.getByLabel('Name', { exact: true }).fill(resource.name);
		let reads = 0;
		let writes = 0;
		let id = '';
		await page.route(`**/api/v1/${resource.path}`, async route => {
			if (route.request().method() === 'POST') {
				writes++;
				const response = await route.fetch();
				id = (await response.json()).id;
				await route.fulfill({ response });
			}
			else {
				reads++;
				await route.fulfill({ status: 503, json: { message: 'Temporary outage' } });
			}
		});
		await editor.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(editor).toBeHidden();
		await expect(page.getByRole('heading', { name: resource.name, exact: true })).toBeVisible();
		await expect(page.getByText(/Saved, but the list could not be refreshed/)).toBeVisible();
		expect(reads).toBe(2);
		expect(writes).toBe(1);
		await page.unroute(`**/api/v1/${resource.path}`);
		await page.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect(page.getByText(/Saved, but the list could not be refreshed/)).toBeHidden();
		const card = page.locator('article').filter({ has: page.getByRole('heading', { name: resource.name, exact: true }) });
		await card.getByRole('button', { name: 'Edit', exact: true }).click();
		await editor.getByLabel('Name', { exact: true }).fill(`${resource.name} edited`);
		await page.route(`**/api/v1/${resource.path}`, route => route.fulfill({ status: 503, json: { message: 'Temporary outage' } }));
		await editor.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(editor).toBeHidden();
		await expect(page.getByRole('heading', { name: `${resource.name} edited`, exact: true })).toBeVisible();
		await expect(page.getByText(/Saved, but the list could not be refreshed/)).toBeVisible();
		await page.unroute(`**/api/v1/${resource.path}`);
		await page.request.delete(`/api/v1/${resource.path}/${id}`, { headers: { 'x-moirai-csrf': csrf } });
	});
}

test('retains a restart failure through polling and clears it after a successful retry', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.clock.install();
	const channelId = randomUUID();
	let reads = 0;
	await page.route('**/api/v1/playback/status', async route => {
		const response = await route.fetch();
		reads++;
		await route.fulfill({ response, json: {
			...await response.json(), activeSessionCount: 1,
			sessions: [{ channelId, channelNumber: '1', channelName: 'Restart test',
				state: 'ready', startedAt: new Date().toISOString(), pid: null,
				lastError: null, acceleration: 'none', clients: [], nowPlaying: null }],
		} });
	});
	let attempts = 0;
	await page.route(`**/api/v1/playback/channels/${channelId}/restart`, route => {
		attempts++;
		return attempts === 1
			? route.fulfill({ status: 503, json: { message: 'Restart failed temporarily' } })
			: route.fulfill({ status: 204 });
	});
	await page.goto('/');
	const restart = page.getByRole('button', { name: 'Restart channel playback' });
	await restart.click();
	await expect(page.getByText('Restart failed temporarily')).toBeVisible();
	const previousReads = reads;
	await page.clock.runFor(15_000);
	await expect.poll(() => reads).toBeGreaterThan(previousReads);
	await expect(page.getByText('Restart failed temporarily')).toBeVisible();
	await restart.click();
	await expect(page.getByText('Restart failed temporarily')).toBeHidden();
	expect(attempts).toBe(2);
});

test('shows playback reconnection, escalates repeated failures, then recovers', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.clock.install();
	let failing = false;
	await page.route('**/api/v1/playback/status', async route => {
		if (failing) {
			await route.fulfill({ status: 503, json: { message: 'Temporarily offline' } });
		}
		else {
			await route.continue();
		}
	});
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Active channels', exact: true })).toBeVisible();
	failing = true;
	await page.clock.runFor(15_000);
	await expect(page.getByText('Reconnecting—showing last update.')).toBeVisible();
	await expect(page.getByText(/Last updated/)).toBeVisible();
	await page.screenshot({ path: 'test-results/status-reconnecting.png' });
	await page.clock.runFor(15_000);
	await page.clock.runFor(15_000);
	await expect(page.getByRole('button', { name: 'Retry playback status' })).toBeVisible();
	failing = false;
	await page.getByRole('button', { name: 'Retry playback status' }).click();
	await expect(page.getByRole('button', { name: 'Retry playback status' })).toBeHidden();
});

test('refreshes missing credit durations on scan completion without changing the draft', async ({ page }) => {
	await authenticateAdministrator(page);
	let socket: WebSocketRoute | undefined;
	await page.routeWebSocket('**/api/v1/events', ws => {
		socket = ws; 
	});
	const libraryId = randomUUID(), id = randomUUID();
	let scanned = false;
	let reads = 0;
	await page.route('**/api/v1/credit-templates/preview-videos', route => {
		reads++;
		return route.fulfill({ json: [{ id, libraryId, title: 'Sample video', durationSeconds: scanned ? 120 : null, artists: [], artworkUrl: null }] });
	});
	await page.goto('/playback/credit-templates');
	await page.getByRole('button', { name: 'New template', exact: true }).click();
	const editor = page.getByRole('dialog');
	await editor.getByLabel('Name', { exact: true }).fill('Keep my draft');
	const source = editor.getByLabel('Credit template (Liquid)');
	const original = await source.inputValue();
	await expect(editor.getByText(/Video duration is unavailable/)).toBeVisible();
	await expect(editor.getByRole('link', { name: 'Inspect video' })).toHaveAttribute('href', `/libraries/${libraryId}/items/${id}`);
	await expect(editor.getByRole('button', { name: 'Render preview' })).toBeDisabled();
	await editor.locator('.credit-preview').screenshot({ path: 'test-results/credit-duration-unavailable.png' });
	scanned = true;
	await expect.poll(() => Boolean(socket)).toBe(true);
	const now = new Date().toISOString();
	socket!.send(JSON.stringify({ type: 'scan.changed', protocolVersion: 1, eventId: randomUUID(), occurredAt: now,
		data: { libraryId, scanId: randomUUID(), trigger: 'manual', status: 'complete', startedAt: now, completedAt: now,
			discoveredCount: 1, changedCount: 1, removedCount: 0, issueCount: 0 } }));
	await expect(editor.getByRole('button', { name: 'Render preview' })).toBeEnabled();
	expect(reads).toBe(2);
	await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Keep my draft');
	await expect(source).toHaveValue(original);
	await expect(editor.getByRole('button', { name: 'Sample video' })).toHaveAttribute('aria-pressed', 'true');
});

test('retries failed schedule summaries on the minute check', async ({ page }) => {
	const csrf = await authenticateAdministrator(page);
	const headers = { 'x-moirai-csrf': csrf };
	const channel = await (await page.request.post('/api/v1/channels', { headers, data: { number: '998', name: 'Summary recovery' } })).json();
	const template = { id: randomUUID() };
	// Use the existing overview contract while supplying only the collection eligibility needed here.
	await page.route('**/api/v1/scheduling/overview', async route => {
		const response = await route.fetch();
		const body = await response.json();
		await route.fulfill({ response, json: { ...body, channelSchedules: [{ channelId: channel.id, baseTemplateId: template.id, layers: [] }] } });
	});
	let reads = 0;
	await page.route('**/api/v1/schedule-guide?*', async route => {
		reads++;
		if (reads === 1) {
			await route.fulfill({ status: 503, json: { message: 'Temporary outage' } });
		}
		else {
			await route.continue();
		}
	});
	await page.clock.install();
	await page.goto('/schedules/channels');
	await expect(page.getByText(/Reconnecting to schedule previews/)).toBeVisible();
	await page.clock.runFor(60_000);
	await expect(page.getByText(/Reconnecting to schedule previews/)).toBeHidden();
	expect(reads).toBe(2);
	await page.request.delete(`/api/v1/channels/${channel.id}`, { headers });
});

test('ignores an older credit sample failure after a newer refresh succeeds', async ({ page }) => {
	await authenticateAdministrator(page);
	const id = randomUUID(), libraryId = randomUUID();
	await page.route('**/api/v1/credit-templates/preview-videos', route => route.fulfill({ json: [
		{ id, libraryId, title: 'Selected video', durationSeconds: null, artists: [], artworkUrl: null },
	] }));
	await page.goto('/playback/credit-templates');
	await page.getByRole('button', { name: 'New template', exact: true }).click();
	const preview = page.locator('.credit-preview');
	await expect(preview.getByText(/Video duration is unavailable/)).toBeVisible();
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve; 
	});
	let reads = 0;
	await page.route('**/api/v1/credit-templates/preview-videos', async route => {
		reads++;
		if (reads === 1) {
			await gate;
			await route.fulfill({ status: 503, json: { message: 'Obsolete failure' } });
		}
		else {
			await route.fulfill({ json: [{ id, libraryId, title: 'Selected video', durationSeconds: 120, artists: [], artworkUrl: null }] });
		}
	});
	await preview.getByRole('button', { name: 'Refresh videos' }).click();
	await expect.poll(() => reads).toBe(1);
	await preview.getByRole('button', { name: 'Refresh videos' }).click();
	await expect(preview.getByRole('button', { name: 'Render preview' })).toBeEnabled();
	const obsolete = page.waitForResponse(response => response.url().endsWith('/credit-templates/preview-videos') && response.status() === 503);
	release();
	await obsolete;
	await expect(preview.getByText('Obsolete failure')).toHaveCount(0);
	await expect(preview.getByRole('button', { name: 'Selected video' })).toHaveAttribute('aria-pressed', 'true');
});
