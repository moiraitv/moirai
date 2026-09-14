import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('shows readable hardware setup failures and links installation guidance from the editor', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.route('**/api/v1/playback/hardware-acceleration/predict', async route => {
		await route.fulfill({ json: { outcome: 'none', accel: null,
			detail: 'VAAPI: Permission denied. Add the host render group ID.\nCUDA: Device missing. Configure NVIDIA Container Toolkit.\nQSV: Encoder unavailable. Use a compatible FFmpeg build.' } });
	});
	await page.goto('/playback/encoding-profiles');
	await page.getByRole('button', { name: 'New Profile', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'New Encoding Profile', exact: true });
	const details = editor.locator('.acceleration-setup-details');
	await expect(details).toHaveAttribute('open', '');
	await expect(details).toContainText('Permission denied');
	await expect(details).toContainText('Device missing');
	await expect(details).toContainText('Encoder unavailable');
	await expect(details.getByRole('link')).toHaveAttribute('href', '/help/getting-started/docker.html#hardware-acceleration');
	await details.scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'test-results/hardware-setup-desktop.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await details.scrollIntoViewIfNeeded();
	await expect(details.getByRole('link')).toBeVisible();
	await page.screenshot({ path: 'test-results/hardware-setup-mobile.png' });
});
