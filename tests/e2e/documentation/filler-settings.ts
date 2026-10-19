import { expect } from '@playwright/test';
import { test } from './fixture';
import { authenticateAdministrator } from '../authentication';

test('saves and resets the complete Playback draft including filler and fallback media', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/settings');
	await page.getByRole('button', { name: /^Break budget warnings/ }).click();
	await page.getByRole('button', { name: /^Global fallback filler/ }).click();
	const tab = page.getByRole('tabpanel', { name: /^Playback/ });
	const warning = tab.getByRole('slider');
	const capacity = tab.getByRole('spinbutton');
	const viewing = tab.getByRole('checkbox');
	const save = tab.getByRole('button', { name: 'Save Playback Settings', exact: true });
	const baseline = await (await page.request.get('/api/v1/playback/settings')).json();
	await expect(save).toBeDisabled();
	await warning.press('Home');
	await warning.press('ArrowRight');
	await expect(warning).toHaveAttribute('aria-valuetext', '1%');
	await capacity.fill('6');
	await viewing.setChecked(!baseline.viewingPreferencesEnabled);
	await tab.locator('input[type=file]').setInputFiles({ name: 'test.mp4', mimeType: 'video/mp4', buffer: Buffer.from('draft') });
	await save.click();
	await expect(page.getByRole('tabpanel', { name: /^Playback/ }).locator('.settings-save-state')).toHaveText('No unsaved changes');
	await expect(save).toBeDisabled();
	expect(await (await page.request.get('/api/v1/playback/settings')).json()).toMatchObject({
		maxActiveSessions: 6, fillerShortfallWarningThresholdPercent: 1, viewingPreferencesEnabled: !baseline.viewingPreferencesEnabled,
	});
	expect(await (await page.request.get('/api/v1/playback/fallback-filler')).json()).toMatchObject({ overrideConfigured: true });

	await capacity.fill('8');
	await viewing.setChecked(baseline.viewingPreferencesEnabled);
	await warning.fill('70');
	await tab.locator('input[type=file]').setInputFiles({ name: 'replacement.mp4', mimeType: 'video/mp4', buffer: Buffer.from('replacement') });
	await tab.getByRole('button', { name: 'Reset Playback settings draft', exact: true }).click();
	await expect(warning).toHaveValue('70');
	await tab.getByRole('button', { name: 'Confirm Reset Playback settings draft', exact: true }).click();
	await expect(capacity).toHaveValue('6');
	await expect(warning).toHaveValue('1');
	await expect(viewing).toBeChecked({ checked: !baseline.viewingPreferencesEnabled });
	await expect(tab.getByText('Pending upload', { exact: true })).toBeHidden();
	await expect(save).toBeDisabled();

	await tab.getByRole('button', { name: 'Remove fallback filler override', exact: true }).click();
	await tab.getByRole('button', { name: 'Confirm remove fallback filler override', exact: true }).click();
	await save.click();
	await expect(page.getByRole('tabpanel', { name: /^Playback/ }).locator('.settings-save-state')).toHaveText('No unsaved changes');
	await expect(save).toBeDisabled();
	expect(await (await page.request.get('/api/v1/playback/fallback-filler')).json()).toMatchObject({ overrideConfigured: false });
	await warning.press('Home');
	await save.click();
	await expect(page.getByRole('tabpanel', { name: /^Playback/ }).locator('.settings-save-state')).toHaveText('No unsaved changes');
	await expect(save).toBeDisabled();
	await page.reload();
	await page.getByRole('button', { name: /^Break budget warnings/ }).click();
	await expect(warning).toHaveValue('0');
});

test('retains Playback drafts on upload failure and retries remaining settings after partial success', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/settings');
	await page.getByRole('button', { name: /^Break budget warnings/ }).click();
	await page.getByRole('button', { name: /^Global fallback filler/ }).click();
	const form = page.getByRole('tabpanel', { name: /^Playback/ });
	const warning = form.getByRole('slider');
	const save = form.getByRole('button', { name: 'Save Playback Settings', exact: true });
	await expect(warning).toHaveValue('80');
	await warning.press('Home');
	await form.getByRole('spinbutton').fill('7');
	await form.locator('input[type=file]').setInputFiles({ name: 'test.mp4', mimeType: 'video/mp4', buffer: Buffer.from('draft') });
	const fallbackUrl = '**/api/v1/playback/fallback-filler';
	let uploads = 0;
	let settingsWrites = 0;
	page.on('request', request => {
		if (request.method() === 'PUT' && request.url().endsWith('/playback/fallback-filler')) {
			uploads += 1;
		}
		if (request.method() === 'PUT' && request.url().endsWith('/playback/settings')) {
			settingsWrites += 1;
		}
	});
	await page.route(fallbackUrl, route => route.request().method() === 'PUT'
		? route.fulfill({ status: 400, json: { message: 'Invalid fallback fixture' } }) : route.continue());
	await save.click();
	await expect(form.getByRole('alert')).toContainText('Invalid fallback fixture');
	await expect(form.getByText('Pending upload', { exact: true })).toBeVisible();
	await expect(warning).toHaveValue('0');
	expect(settingsWrites).toBe(0);
	await page.unroute(fallbackUrl);
	await page.route('**/api/v1/playback/settings', route => route.request().method() === 'PUT'
		? route.fulfill({ status: 500, json: { message: 'Settings fixture failure' } }) : route.continue());
	await save.click();
	await expect(form.getByRole('alert')).toContainText('Fallback saved, but playback settings could not be saved');
	await expect(form.getByText('Pending upload', { exact: true })).toBeHidden();
	await expect(save).toBeEnabled();
	await page.unroute('**/api/v1/playback/settings');
	await save.click();
	await expect(page.getByRole('tabpanel', { name: /^Playback/ }).locator('.settings-save-state')).toHaveText('No unsaved changes');
	await expect(save).toBeDisabled();
	expect(uploads).toBe(2);
	expect(settingsWrites).toBe(2);
	expect(await (await page.request.get('/api/v1/playback/settings')).json()).toMatchObject({ maxActiveSessions: 7, fillerShortfallWarningThresholdPercent: 0 });
});
