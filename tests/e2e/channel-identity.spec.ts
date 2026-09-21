import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('opens a channel editor link after a newer catalog request supersedes its initial read', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const response = await page.request.post('/api/v1/channels', {
		headers, data: { number: '875', name: 'Delayed channel catalog', group: 'Test Movies' },
	});
	expect(response.ok()).toBe(true);
	const channel = await response.json();
	let releaseFirst!: () => void;
	let releaseLatest!: () => void;
	const firstGate = new Promise<void>(resolve => {
		releaseFirst = resolve;
	});
	const latestGate = new Promise<void>(resolve => {
		releaseLatest = resolve;
	});
	let reads = 0;
	let superseding = false;
	await page.route('**/api/v1/channels', async (route) => {
		reads += 1;
		const first = !superseding;
		await (first ? firstGate : latestGate);
		await route.fulfill({ json: first ? [] : [channel] });
	});
	try {
		const guideLoaded = page.waitForResponse(response => response.url().includes('/api/v1/schedule-guide?'));
		await page.goto(`/channels?edit=${channel.id}`);
		await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
		const initialReads = reads;
		superseding = true;
		const updated = await page.request.patch(`/api/v1/channels/${channel.id}`, {
			headers, data: { number: channel.number, name: channel.name, group: channel.group },
		});
		expect(updated.ok()).toBe(true);
		await expect.poll(() => reads).toBeGreaterThan(initialReads);
		releaseFirst();
		await guideLoaded;
		await expect(page.getByText('Channel not found. It may have been deleted.', { exact: true })).toBeHidden();
		releaseLatest();
		const editor = page.getByRole('dialog', { name: 'Edit Channel', exact: true });
		await expect(editor.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(channel.name);
	}
	finally {
		releaseFirst();
		releaseLatest();
		await page.unrouteAll({ behavior: 'wait' });
		await page.request.delete(`/api/v1/channels/${channel.id}`, { headers });
	}
});

test('checks channel identity while typing and keeps mobile editor actions compact', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const created: string[] = [];
	for (const number of ['876', '876.1', '876.2', '876.10']) {
		const response = await page.request.post('/api/v1/channels', {
			headers, data: { number, name: `Station ${number}`, group: 'Test Movies' },
		});
		expect(response.ok()).toBe(true);
		created.push((await response.json()).id);
	}
	await page.goto(`/channels?edit=${created[0]}`);
	const editor = page.getByRole('dialog', { name: 'Edit Channel', exact: true });
	const number = editor.getByRole('textbox', { name: 'Number', exact: true });
	await expect(number).toHaveAttribute('inputmode', 'decimal');
	await expect(number).toHaveAttribute('aria-invalid', 'false');
	await expect(editor.locator('#channel-number-feedback li')).toHaveText(['876.1 · Station 876.1', '876.2 · Station 876.2', '876.10 · Station 876.10']);
	await number.fill('876.1');
	await expect(number).toHaveAttribute('aria-invalid', 'true');
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await number.fill('877');
	await expect(number).toHaveAttribute('aria-invalid', 'false');
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	await expect(editor.locator('#channel-group-suggestions option[value="Test Movies"]')).toHaveCount(1);
	const row = editor.locator('.encoding-profile-selector-row');
	const selectBox = await row.locator('select').boundingBox();
	const manageBox = await row.getByRole('link').boundingBox();
	expect(selectBox?.height).toBe(manageBox?.height);
	await page.setViewportSize({ width: 375, height: 667 });
	const remove = editor.getByRole('button', { name: 'Delete Channel', exact: true });
	const save = editor.getByRole('button', { name: 'Save', exact: true });
	await expect(remove).toBeVisible();
	const removeBox = await remove.boundingBox();
	const saveBox = await save.boundingBox();
	expect(removeBox?.width).toBe(44);
	expect(saveBox?.width).toBe(44);
	expect(removeBox?.y).toBe(saveBox?.y);
	await editor.getByRole('button', { name: 'Reset', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Confirm Reset', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await page.screenshot({ path: 'test-results/channel-editor-mobile.png' });
	await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(number).toHaveValue('876');
	for (const id of created) {
		await page.request.delete(`/api/v1/channels/${id}`, { headers });
	}
});
