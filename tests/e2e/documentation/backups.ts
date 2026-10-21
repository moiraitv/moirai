import { expect } from '@playwright/test';
import { test } from './fixture';
import { authenticateAdministrator } from '../authentication';
import { normalizeDocumentationBackup } from './backup-fixture';
import { capture, captureSection } from './capture';

test('captures backup settings', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	await page.goto(documentationServer.url);
	const csrf = await authenticateAdministrator(page);
	await page.goto('/settings');
	await capture(page, 'settings.png');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	const panel = page.getByRole('tabpanel', { name: /^Backups/ });
	await expect(panel.getByText('No saved backups yet.')).toBeVisible();
	const created = await page.request.post(`${documentationServer.url}/api/v1/backups`, { headers: { 'x-moirai-csrf': csrf } });
	expect(created.ok()).toBe(true);
	await normalizeDocumentationBackup(documentationServer.directory, await created.json());
	await page.reload();
	await page.getByRole('tab', { name: /^Backups/ }).click();
	const row = panel.getByRole('row').filter({ hasText: 'Manual' });
	await expect(row).toBeVisible();
	await captureSection(page, panel, 'backup-settings.png');
	await row.getByRole('button', { name: 'Restore', exact: true }).click();
	await page.getByRole('alertdialog', { name: 'Restore Backup?' }).getByRole('button', { name: 'Validate Backup' }).click();
	const review = page.getByRole('alertdialog', { name: 'Replace Configuration?' });
	await expect(review.getByRole('button', { name: 'Restore and Restart' })).toBeEnabled({ timeout: 30_000 });
	await captureSection(page, review, 'backup-restore.png');
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(review.getByRole('button', { name: 'Restore and Restart' })).toBeInViewport();
	for (const button of await review.locator('footer button').all()) {
		expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	}
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.screenshot({ path: 'test-results/backup-restore-mobile.png' });
	await review.getByRole('button', { name: 'Cancel Restore' }).click();
	await page.setViewportSize({ width: 390, height: 844 });
	await panel.scrollIntoViewIfNeeded();
	await expect(panel.getByRole('button', { name: 'Create Backup', exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
