import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('retains independent settings drafts across keyboard tab switches and protects page departure', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/settings');
	const playback = page.getByRole('tab', { name: /^Playback/ });
	const ai = page.getByRole('tab', { name: /^AI/ });
	const backups = page.getByRole('tab', { name: /^Backups/ });
	const capacity = page.getByRole('spinbutton', { name: /^Maximum active channel sessions/ });
	const saved = await capacity.inputValue();
	await capacity.fill(saved === '6' ? '7' : '6');
	await expect(playback).toHaveAccessibleName(/Unsaved changes/);
	await playback.focus();
	await page.keyboard.press('ArrowRight');
	await expect(ai).toBeFocused();
	await expect(ai).toHaveAttribute('aria-selected', 'true');
	await page.getByLabel('API Key', { exact: false }).fill('draft-key-for-tab-test');
	await expect(ai).toHaveAccessibleName(/Unsaved changes/);
	await ai.focus();
	await page.keyboard.press('End');
	await expect(backups).toBeFocused();
	await page.getByRole('button', { name: 'Automatic Backup', exact: true }).click();
	const interval = page.getByLabel('Backup interval (days)');
	const savedInterval = await interval.inputValue();
	await interval.fill(savedInterval === '3' ? '4' : '3');
	await expect(backups).toHaveAccessibleName(/Unsaved changes/);
	await backups.focus();
	await page.keyboard.press('ArrowRight');
	await expect(playback).toBeFocused();
	await expect(capacity).toHaveValue(saved === '6' ? '7' : '6');
	await page.getByRole('button', { name: 'Save Playback Settings', exact: true }).click();
	await expect(playback).not.toHaveAccessibleName(/Unsaved changes/);
	await expect(ai).toHaveAccessibleName(/Unsaved changes/);
	await expect(backups).toHaveAccessibleName(/Unsaved changes/);
	await page.getByRole('link', { name: 'Quick Setup', exact: true }).click();
	await expect(page.getByRole('alertdialog', { name: 'Discard Unsaved Changes?' })).toBeVisible();
	await page.getByRole('button', { name: 'Keep Editing', exact: true }).click();
	await ai.click();
	await expect(page.getByLabel('API Key', { exact: false })).toHaveValue('draft-key-for-tab-test');
	await page.getByRole('button', { name: 'Reset AI settings draft', exact: true }).click();
	await page.getByRole('button', { name: 'Confirm Reset AI settings draft', exact: true }).click();
	await expect(page.getByLabel('API Key', { exact: false })).toHaveValue('');
	await expect(ai).not.toHaveAccessibleName(/Unsaved changes/);
	await expect(backups).toHaveAccessibleName(/Unsaved changes/);
	await backups.click();
	await expect(interval).toHaveValue(savedInterval === '3' ? '4' : '3');
});

test('exposes hidden-tab failures and distinguishes pending playback data from saved summaries', async ({ page }) => {
	await authenticateAdministrator(page);
	let release!: () => void;
	const pending = new Promise<void>(resolve => {
		release = resolve;
	});
	await page.route('**/api/v1/playback/settings', async route => {
		await pending;
		await route.continue();
	});
	await page.route('**/api/v1/ai/settings', route => route.fulfill({ status: 503, json: { message: 'AI temporarily unavailable' } }));
	await page.route('**/api/v1/backups', route => route.fulfill({ status: 503, json: { message: 'Backup volume unavailable' } }));
	await page.goto('/settings');
	const warning = page.getByRole('button', { name: /^Break budget warnings/ });
	await expect(warning).toContainText('Loading…');
	await expect(warning).not.toContainText('80%');
	const ai = page.getByRole('tab', { name: /^AI/ });
	const backups = page.getByRole('tab', { name: /^Backups/ });
	await expect(ai).toHaveAccessibleName(/Needs attention/);
	await expect(backups).toHaveAccessibleName(/Needs attention/);
	release();
	await expect(warning).toContainText('Below');
	await ai.click();
	await expect(page.getByRole('tabpanel', { name: /^AI/ }).getByRole('alert')).toContainText('AI temporarily unavailable');
	await backups.click();
	await expect(page.getByRole('tabpanel', { name: /^Backups/ }).getByRole('alert')).toContainText('Backup volume unavailable');
	await expect(page.getByText('No saved backups yet.')).toBeHidden();
});

test('keeps collapsed playback drafts, keeps disclosure focus and fits narrow viewports with reduced motion', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/settings');
	const warning = page.getByRole('button', { name: /^Break budget warnings/ });
	await expect(warning).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('slider')).toBeHidden();
	await warning.click();
	const slider = page.getByRole('slider');
	await slider.fill('45');
	await warning.click();
	await expect(slider).toBeHidden();
	await expect(warning).toBeFocused();
	await expect(warning).toContainText('Unsaved');
	await warning.click();
	await expect(slider).toHaveValue('45');
	await slider.focus();
	await page.getByRole('tab', { name: /^AI/ }).click();
	await page.getByRole('tab', { name: /^Playback/ }).click();
	await expect(slider).toHaveValue('45');
	await page.getByRole('button', { name: /^Global fallback filler/ }).click();
	await page.getByRole('button', { name: 'Engine details', exact: true }).click();
	for (const width of [320, 390, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(page.getByRole('button', { name: 'Save Playback Settings' })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	}
	await page.screenshot({ path: 'test-results/settings-tabs-desktop.png', fullPage: true });
	await page.getByRole('tab', { name: /^Backups/ }).click();
	await page.getByRole('button', { name: 'Automatic Backup', exact: true }).click();
	for (const width of [320, 390]) {
		await page.setViewportSize({ width, height: 844 });
		await expect(page.getByRole('button', { name: 'Save Backup Settings' })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	}
	await page.screenshot({ path: 'test-results/settings-backups-mobile.png', fullPage: true });
});


test('keeps the automatic backup switch independent while one disclosure reveals all policy details', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/settings');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	const tab = page.getByRole('tabpanel', { name: /^Backups/ });
	const disclosure = tab.getByRole('button', { name: 'Automatic Backup', exact: true });
	const enabled = tab.getByRole('switch', { name: 'Enable automatic backups' });
	await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
	await expect(tab.getByLabel('Backup interval (days)')).toBeHidden();
	const baselineEnabled = await enabled.isChecked();
	await enabled.setChecked(!baselineEnabled);
	await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
	await expect(tab.getByRole('button', { name: 'Save Backup Settings' })).toBeEnabled();
	await disclosure.click();
	await expect(tab.getByLabel('Backup interval (days)')).toBeVisible();
	await expect(tab.getByLabel('Automatic backups to retain')).toBeVisible();
	await expect(tab.locator('.backup-details code')).toBeVisible();
	await tab.getByRole('button', { name: 'Reset Backup settings draft', exact: true }).click();
	await tab.getByRole('button', { name: 'Confirm Reset Backup settings draft', exact: true }).click();
	await expect(enabled).toBeChecked({ checked: baselineEnabled });
	await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
	await disclosure.click();
	await expect(tab.getByLabel('Backup interval (days)')).toBeHidden();
	await expect(tab.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();
});
