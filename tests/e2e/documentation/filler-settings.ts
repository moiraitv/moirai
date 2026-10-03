import { expect } from '@playwright/test';
import { test } from './fixture';
import { authenticateAdministrator } from '../authentication';

test('saves and resets the whole filler block while preserving other settings drafts', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/settings');
	const warning = page.getByRole('slider', { name: 'Warn when filler supplies less than (%)', exact: true });
	const form = page.locator('.fallback-filler-panel');
	const save = form.getByRole('button', { name: 'Save Filler Settings', exact: true });
	await expect(warning).toHaveValue('80');
	await expect(save).toBeDisabled();
	await warning.press('Home');
	await expect(warning).toHaveValue('0');
	await warning.press('ArrowRight');
	await expect(warning).toHaveValue('1');
	await expect(warning).toHaveAttribute('aria-valuetext', '1%');

	const capacity = page.getByRole('spinbutton', { name: /^Maximum active channel sessions/ });
	await capacity.fill('6');
	await warning.press('End');
	await expect(warning).toHaveValue('100');
	for (let i = 0; i < 20; i += 1) {
		await warning.press('ArrowLeft');
	}
	await page.locator('.fallback-filler-editor input[type=file]').setInputFiles({ name: 'test.mp4', mimeType: 'video/mp4', buffer: Buffer.from('draft') });
	await expect(save).toBeEnabled();
	await save.click();
	await expect(save).toBeDisabled();
	await expect(capacity).toHaveValue('6');
	expect(await (await page.request.get('/api/v1/playback/fallback-filler')).json()).toMatchObject({ overrideConfigured: true });
	const persisted = await page.request.get('/api/v1/playback/settings');
	expect(await persisted.json()).toMatchObject({ maxActiveSessions: 4, fillerShortfallWarningThresholdPercent: 80 });

	await page.locator('form').filter({ has: capacity }).getByRole('button', { name: 'Save Settings', exact: true }).click();
	await expect(page.locator('form').filter({ has: capacity }).getByRole('button', { name: 'Save Settings', exact: true })).toBeDisabled();
	expect(await (await page.request.get('/api/v1/playback/settings')).json()).toMatchObject({ maxActiveSessions: 6, fillerShortfallWarningThresholdPercent: 80 });
	for (let i = 0; i < 10; i += 1) {
		await warning.press('ArrowLeft');
	}
	await page.locator('.fallback-filler-editor input[type=file]').setInputFiles({ name: 'replacement.mp4', mimeType: 'video/mp4', buffer: Buffer.from('replacement') });
	await form.getByRole('button', { name: 'Reset filler settings draft', exact: true }).click();
	await expect(warning).toHaveValue('70');
	await form.getByRole('button', { name: 'Confirm Reset filler settings draft', exact: true }).click();
	await expect(warning).toHaveValue('80');
	await expect(save).toBeDisabled();
	await expect(form.getByText('Pending upload', { exact: true })).toBeHidden();
	expect(await (await page.request.get('/api/v1/playback/fallback-filler')).json()).toMatchObject({ overrideConfigured: true });
	await form.getByRole('button', { name: 'Remove fallback filler override', exact: true }).click();
	await form.getByRole('button', { name: 'Confirm remove fallback filler override', exact: true }).click();
	await expect(save).toBeEnabled();
	await save.click();
	await expect(save).toBeDisabled();
	expect(await (await page.request.get('/api/v1/playback/fallback-filler')).json()).toMatchObject({ overrideConfigured: false });

	await warning.press('Home');
	await save.click();
	await expect(save).toBeDisabled();
	await page.reload();
	await expect(warning).toHaveValue('0');
});

test('retains filler drafts on upload failure and retries only the unsaved threshold after partial success', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/settings');
	const form = page.locator('.fallback-filler-panel');
	const warning = form.getByRole('slider');
	const save = form.getByRole('button', { name: 'Save Filler Settings', exact: true });
	await expect(warning).toHaveValue('80');
	await warning.press('Home');
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
	await expect(form.getByRole('alert')).toContainText('Fallback saved, but warning settings could not be saved');
	await expect(form.getByText('Pending upload', { exact: true })).toBeHidden();
	await expect(save).toBeEnabled();
	await page.unroute('**/api/v1/playback/settings');
	await save.click();
	await expect(save).toBeDisabled();
	expect(uploads).toBe(2);
	expect(settingsWrites).toBe(2);
	expect(await (await page.request.get('/api/v1/playback/settings')).json()).toMatchObject({ fillerShortfallWarningThresholdPercent: 0 });
});
