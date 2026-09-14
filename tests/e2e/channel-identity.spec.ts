import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

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
