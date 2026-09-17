import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('shows an in-app missing page for unknown management paths', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/does-not-exist');
	await expect(page.getByRole('heading', { name: 'Page Not Found' })).toBeVisible();
	await expect(page.getByText('404 Not Found', { exact: true })).toBeVisible();
	await page.getByRole('link', { name: 'Go to Status', exact: true }).click();
	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: 'Status' })).toBeVisible();
});
