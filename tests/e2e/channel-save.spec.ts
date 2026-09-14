import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('shows a confirmed new channel and releases Save while lineup refreshes are pending', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	await page.goto('/channels');
	await expect(page.getByText('Loading channels and guide…', { exact: true })).toBeHidden();
	await page.getByRole('button', { name: 'New Channel', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'Create Channel', exact: true });
	await editor.getByRole('textbox', { name: 'Number', exact: true }).fill('987');
	await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Immediately visible');
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

	let releaseRefreshes!: () => void;
	const refreshGate = new Promise<void>(resolve => {
		releaseRefreshes = resolve; 
	});
	let pendingRefreshes = 0;
	await page.route('**/api/v1/**', async (route) => {
		const request = route.request();
		const pathname = new URL(request.url()).pathname;
		if (request.method() === 'GET' && (pathname === '/api/v1/channels' || pathname.startsWith('/api/v1/scheduling/'))) {
			pendingRefreshes += 1;
			await refreshGate;
		}
		await route.continue();
	});

	let channelId: string | undefined;
	try {
		const created = page.waitForResponse(response => response.request().method() === 'POST'
			&& new URL(response.url()).pathname === '/api/v1/channels');
		await editor.getByRole('button', { name: 'Save', exact: true }).click();
		const response = await created;
		expect(response.status()).toBe(201);
		channelId = (await response.json()).id;
		await expect.poll(() => pendingRefreshes).toBeGreaterThan(0);
		await expect(editor).toBeHidden();
		await page.getByRole('button', { name: 'Edit Immediately visible', exact: true }).click();
		const reopened = page.getByRole('dialog', { name: 'Edit Channel', exact: true });
		await reopened.getByRole('textbox', { name: 'Name', exact: true }).fill('Ready to edit');
		await expect(reopened.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	}
	finally {
		releaseRefreshes();
		await page.unrouteAll({ behavior: 'wait' });
		if (channelId) {
			await page.request.delete(`/api/v1/channels/${channelId}`, { headers });
		}
	}
});
