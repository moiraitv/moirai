import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { authenticateAdministrator } from './authentication';

test('saves block artwork once across retries and keeps reset, removal, and discard draft-local', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const buffer = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#37678c' } }).png().toBuffer();
	const file = { name: 'guide.png', mimeType: 'image/png', buffer };
	let uploads = 0;
	page.on('request', request => {
		if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/guide-artwork') {
			uploads += 1;
		}
	});
	await page.goto('/schedules/templates/new');
	const editor = page.getByRole('dialog', { name: 'Template editor', exact: true });
	await editor.getByLabel('Template name').fill('Custom block image');
	await editor.getByLabel('Show in guide').selectOption('block');
	const chooser = page.waitForEvent('filechooser');
	await editor.getByRole('button', { name: 'Choose image', exact: true }).click();
	await (await chooser).setFiles(file);
	const preview = editor.getByAltText('Guide artwork preview');
	await expect(preview).toBeVisible();
	await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(160);
	expect(uploads).toBe(0);

	await page.route('**/api/v1/guide-artwork', route => route.fulfill({ status: 503, json: { message: 'Image upload unavailable' } }));
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor.getByText('Image upload unavailable')).toBeVisible();
	await expect(preview).toBeVisible();
	await page.unroute('**/api/v1/guide-artwork');

	await page.route('**/api/v1/schedule-templates', async route => {
		if (route.request().method() === 'POST') {
			await route.fulfill({ status: 503, json: { message: 'Save temporarily unavailable' } });
		}
		else {
			await route.continue();
		}
	});
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor.getByText('Save temporarily unavailable')).toBeVisible();
	expect(uploads).toBe(2);
	await page.unroute('**/api/v1/schedule-templates');
	const savedResponse = page.waitForResponse(response => response.request().method() === 'POST'
		&& new URL(response.url()).pathname === '/api/v1/schedule-templates');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	const saved = await (await savedResponse).json();
	await expect(editor).toBeHidden();
	expect(uploads).toBe(2);
	const artworkId = saved.slots[0].guide.artworkId;
	expect(artworkId).toBeTruthy();

	await page.goto(`/schedules/templates/${saved.id}`);
	await expect(preview).toHaveAttribute('src', `/api/v1/guide-artwork/${artworkId}`);
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(preview).toBeVisible();
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
	await page.setViewportSize({ width: 1280, height: 720 });
	await editor.getByLabel('Guide artwork', { exact: true }).setInputFiles(file);
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	await editor.getByRole('button', { name: 'Reset', exact: true }).click();
	await editor.getByRole('button', { name: /Confirm.*reset/i }).click();
	await expect(preview).toHaveAttribute('src', `/api/v1/guide-artwork/${artworkId}`);
	expect(uploads).toBe(2);

	await editor.getByRole('button', { name: 'Remove artwork', exact: true }).click();
	await editor.getByRole('button', { name: 'Confirm remove artwork', exact: true }).click();
	await expect(preview).toBeHidden();
	await editor.getByRole('button', { name: 'Close template editor' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: /discard/i }).click();
	await page.goto(`/schedules/templates/${saved.id}`);
	await expect(preview).toHaveAttribute('src', `/api/v1/guide-artwork/${artworkId}`);
	await editor.getByRole('button', { name: 'Remove artwork', exact: true }).click();
	await editor.getByRole('button', { name: 'Confirm remove artwork', exact: true }).click();
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toBeHidden();
	const updated = await (await page.request.get(`/api/v1/schedule-templates/${saved.id}`)).json();
	expect(updated.slots[0].guide.artworkId).toBeUndefined();
	await page.request.delete(`/api/v1/schedule-templates/${saved.id}`, { headers });
});
