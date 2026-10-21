import { expect } from '@playwright/test';
import { test } from './fixture';
import { authenticateAdministrator } from '../authentication';

// Exercise the real bundled manifest and guide anchors, including focus restoration.
test('opens Settings card help at the matching tab guide section', async ({ page, documentationServer }) => {
	await page.goto(documentationServer.url);
	await authenticateAdministrator(page);
	await page.goto('/settings');
	await expect(page.getByRole('button', { name: 'Help with Settings', exact: true })).toHaveCount(0);
	const sections = [
		['Playback', 'Playback capacity', 'playback', 'playback-capacity', 'Maximum active channel sessions'],
		['Playback', 'Audio selection defaults', 'playback', 'audio-selection-defaults', 'Preferred language code'],
		['Playback', 'Filler', 'playback', 'filler', 'Warn when filler supplies less than'],
		['Playback', 'Viewing preferences', 'playback', 'viewing-preferences', 'View Current Scores'],
		['Playback', 'Playback status', 'playback', 'playback-status', 'Refresh Status'],
		['AI', 'AI provider', 'ai', 'ai-provider', 'Custom'],
		['Backups', 'Backup & Restore', 'backups', 'backup-and-restore', 'exclude'],
		['Backups', 'Automatic Backup', 'backups', 'automatic-backup', 'Backup interval'],
		['Backups', 'Backups', 'backups', 'backups', 'Create Backup'],
	] as const;
	for (const [tab, title, guide, anchor, content] of sections) {
		await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
		const button = page.getByRole('button', { name: `Help with ${title}`, exact: true });
		await button.click();
		const drawer = page.getByRole('dialog');
		await expect(drawer).toBeFocused();
		await expect(drawer.getByRole('heading', { name: title, exact: true })).toBeVisible();
		await expect(drawer.locator('.help-markdown')).toContainText(content);
		const fullGuide = drawer.getByRole('link', { name: 'Open full guide' });
		await expect(fullGuide).toHaveAttribute('href', `/help/settings/${guide}.html#${anchor}`);
		const popup = page.waitForEvent('popup');
		await fullGuide.click();
		const guidePage = await popup;
		await expect(guidePage.locator(`h2#${anchor}`)).toBeVisible();
		await expect(guidePage.locator('.VPSidebar').getByText('Settings', { exact: true })).toBeVisible();
		await guidePage.close();
		await page.keyboard.press('Escape');
		await expect(drawer).toBeHidden();
		await expect(button).toBeFocused();
	}
	// The adjacent help control must not expand the automatic policy or change its switch.
	await expect(page.getByRole('button', { name: 'Automatic Backup', exact: true })).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('switch', { name: 'Enable automatic backups' })).toBeChecked();
});
