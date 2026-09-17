import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './documentation/fixture';
import { authenticateAdministrator, E2E_ADMIN_PASSWORD } from './authentication';

async function expectFieldError(field: Locator, message: RegExp): Promise<void> {
	await field.blur();
	await expect(field).toHaveAttribute('aria-invalid', 'true');
	await expect(field).toHaveAccessibleDescription(message);
}

async function refreshStatus(page: Page): Promise<void> {
	const refresh = page.getByRole('button', { name: 'Refresh Status' });
	await Promise.all([
		page.waitForResponse(response => response.url().endsWith('/api/v1/playback/status')),
		refresh.click(),
	]);
	await expect(refresh).toBeEnabled();
}

test('recovers Settings resources independently and preserves drafts and save failures', async ({ page }) => {
	await authenticateAdministrator(page);
	let settingsFailed = true;
	let historyFailed = true;
	let fallbackFailed = true;
	let saveFailed = true;
	let settingsReads = 0;
	await page.route('**/api/v1/playback/settings', async route => {
		if (route.request().method() === 'GET') {
			settingsReads++;
			if (settingsFailed) {
				await route.fulfill({ status: 503, json: { message: 'Settings unavailable' } });
				return;
			}
		}
		else if (saveFailed) {
			await route.fulfill({ status: 503, json: { message: 'Capacity save failed' } });
			return;
		}
		await route.continue();
	});
	await page.route('**/api/v1/viewing-preferences?*', route => historyFailed
		? route.fulfill({ status: 503, json: { message: 'History unavailable' } }) : route.continue());
	await page.route('**/api/v1/playback/fallback-filler', route => fallbackFailed
		? route.fulfill({ status: 503, json: { message: 'Fallback unavailable' } }) : route.continue());
	await page.goto('/settings');
	const capacity = page.getByRole('spinbutton', { name: /Maximum active channel sessions/ });
	await expect(page.getByText('Settings unavailable', { exact: true })).toBeVisible();
	await expect(capacity).toHaveCount(0);
	await expect(page.getByRole('checkbox')).toHaveCount(0);
	await page.screenshot({ path: 'test-results/batch2-settings-recovery.png' });
	await refreshStatus(page);
	await expect(page.getByText('Settings unavailable', { exact: true })).toBeVisible();
	expect(settingsReads).toBe(1);
	settingsFailed = false;
	await page.getByRole('button', { name: 'Retry Settings' }).click();
	await expect(capacity).toHaveValue('4');
	await capacity.fill('0');
	await expectFieldError(capacity, /at least 1/);
	await capacity.fill('9');
	await expect(capacity).not.toHaveAttribute('aria-invalid');
	const playback = page.locator('form').filter({ has: capacity });
	await playback.getByRole('button', { name: 'Save Settings' }).click();
	await expect(playback).toContainText('Capacity save failed');
	await refreshStatus(page);
	await expect(playback).toContainText('Capacity save failed');
	await Promise.all([
		page.waitForResponse(response => response.url().endsWith('/api/v1/playback/status')),
		page.clock.fastForward(15_000),
	]);
	await expect(page.getByRole('button', { name: 'Refresh Status' })).toBeEnabled();
	await expect(playback).toContainText('Capacity save failed');
	await page.locator('.fallback-filler-panel input[type="file"]').setInputFiles({ name: 'draft.mp4', mimeType: 'video/mp4', buffer: Buffer.from('unsaved fixture') });
	fallbackFailed = false;
	await page.getByRole('button', { name: 'Retry Fallback' }).click();
	await expect(page.getByText('Fallback unavailable', { exact: true })).toBeHidden();
	await page.getByRole('button', { name: 'View Current Scores' }).click();
	await expect(page.getByRole('heading', { name: 'Current scores' })).toBeVisible();
	await expect(page.getByText('History unavailable', { exact: true })).toBeVisible();
	historyFailed = false;
	await page.getByRole('button', { name: 'Retry History' }).click();
	await expect(page.getByText('History unavailable', { exact: true })).toBeHidden();
	await page.getByRole('button', { name: 'Close current scores' }).click();
	await expect(page.locator('.fallback-filler-panel')).toContainText('draft.mp4');
	await expect(capacity).toHaveValue('9');
	saveFailed = false;
	await page.getByRole('checkbox').uncheck();
	await page.locator('.viewing-preferences-panel').getByRole('button', { name: 'Save Settings' }).click();
	await expect(page.locator('.viewing-preferences-panel').getByRole('button', { name: 'Save Settings' })).toBeDisabled();
	await expect(capacity).toHaveValue('9');
	await expect(playback).toContainText('Capacity save failed');
	await playback.getByRole('button', { name: 'Save Settings' }).click();
	await expect(playback.getByRole('button', { name: 'Save Settings' })).toBeDisabled();
	await expect(playback).not.toContainText('Capacity save failed');
	await expect(page.locator('.fallback-filler-panel')).toContainText('draft.mp4');
});

test('keeps loaded Settings editable when initial status fails and retries status alone', async ({ page }) => {
	await authenticateAdministrator(page);
	let failed = true;
	await page.route('**/api/v1/playback/status', route => failed
		? route.fulfill({ status: 503, json: { message: 'Status unavailable' } }) : route.continue());
	await page.goto('/settings');
	const capacity = page.getByRole('spinbutton', { name: /Maximum active channel sessions/ });
	await expect(capacity).toHaveValue('4');
	await expect(page.locator('.playback-card')).toContainText('Status unavailable');
	await expect(page.locator('.playback-card h2')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Copy channel playlist URL' })).toHaveCount(0);
	await capacity.fill('8');
	failed = false;
	await page.getByRole('button', { name: 'Retry Status' }).click();
	await expect(page.locator('.playback-card')).not.toContainText('Status unavailable');
	await expect(page.getByRole('button', { name: 'Copy channel playlist URL' })).toBeVisible();
	await expect(capacity).toHaveValue('8');
});

test('explains Account errors after blur and clears feedback after successful credential changes', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/account');
	const username = page.getByRole('textbox', { name: /^Username/ });
	const password = page.getByLabel('New password', { exact: false }).first();
	const confirmation = page.getByLabel('Confirm new password', { exact: false });
	const current = page.getByLabel('Current password', { exact: false });
	await username.fill('x');
	await expect(username).not.toHaveAttribute('aria-invalid');
	await expectFieldError(username, /at least 3 characters/);
	await username.fill('e2e-admin');
	await password.fill('short');
	await expectFieldError(password, /at least 15 characters/);
	await password.fill('replacement sufficiently long password');
	await confirmation.fill('different sufficiently long password');
	await expect(confirmation).not.toHaveAttribute('aria-invalid');
	await expectFieldError(confirmation, /Passwords do not match/);
	await confirmation.scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'test-results/batch2-account-validation.png' });
	await confirmation.fill('replacement sufficiently long password');
	await expect(confirmation).not.toHaveAttribute('aria-invalid');
	await current.focus();
	await expectFieldError(current, /Enter a value/);
	await current.fill('wrong current password');
	await page.getByRole('button', { name: 'Update Credentials' }).click();
	await expect(page.locator('.account-panel .notice.error')).toBeVisible();
	await current.fill(E2E_ADMIN_PASSWORD);
	await page.getByRole('button', { name: 'Update Credentials' }).click();
	await expect(current).toHaveValue('');
	await expect(password).toHaveValue('');
	await expect(confirmation).toHaveValue('');
	await expect(page.locator('.field-error')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Update Credentials' })).toBeDisabled();
});

for (const channel of [false, true]) {
	test(`explains encoding errors and resets feedback for ${channel ? 'channel Custom settings' : 'encoding profiles'}`, async ({ page }) => {
		const csrfToken = await authenticateAdministrator(page);
		if (channel) {
			await page.request.post('/api/v1/channels', { headers: { 'x-moirai-csrf': csrfToken }, data: { number: '1', name: 'Validation channel' } });
			await page.goto('/channels');
			await page.getByRole('button', { name: 'Edit Validation channel', exact: true }).click();
			await page.getByRole('combobox', { name: 'Audio and video settings', exact: true }).selectOption('');
		}
		else {
			await page.goto('/playback/encoding-profiles');
			await page.getByRole('button', { name: 'View', exact: true }).first().click();
			await expect(page.getByRole('dialog').locator('.field-error')).toHaveCount(0);
			await page.getByRole('dialog').getByRole('button', { name: 'Duplicate', exact: true }).click();
		}
		const dialog = page.getByRole('dialog').last();
		const width = dialog.getByRole('spinbutton', { name: /^Width/ });
		const baselineWidth = await width.inputValue();
		await width.fill('-1');
		await expect(width).not.toHaveAttribute('aria-invalid');
		await expectFieldError(width, /greater than 0/);
		await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		await expect(dialog.locator('.resource-editor-validation')).toBeVisible();
		await width.fill('1.5');
		await expect(width).toHaveAccessibleDescription(/whole number/);
		await width.fill('');
		await expect(width).toHaveAccessibleDescription(/Enter a number/);
		await width.fill(baselineWidth);
		await expect(width).not.toHaveAttribute('aria-invalid');
		const depth = dialog.getByRole('spinbutton', { name: /^Bit depth/ });
		await depth.fill('17');
		await expectFieldError(depth, /no greater than 16/);
		await page.setViewportSize({ width: 390, height: 844 });
		if (channel) {
			await dialog.getByRole('button', { name: /Video & audio settings/ }).click();
			await expect(dialog.locator('.resource-editor-validation')).toBeVisible();
			await expect(dialog.locator('.channel-encoding-disclosure > .form-disclosure-content')).toBeHidden();
		}
		else {
			await depth.scrollIntoViewIfNeeded();
		}
		await page.screenshot({ path: `test-results/batch2-${channel ? 'channel' : 'encoding'}-validation.png` });
		const footer = await dialog.locator('.resource-editor-action-bar').boundingBox();
		expect(footer!.x).toBeGreaterThanOrEqual(0);
		expect(footer!.x + footer!.width).toBeLessThanOrEqual(390);
		if (channel) {
			const profile = dialog.getByRole('combobox', { name: 'Audio and video settings', exact: true });
			const preset = await profile.locator('option').nth(1).getAttribute('value');
			await profile.selectOption(preset!);
			await expect(dialog.locator('.field-error')).toHaveCount(0);
			await profile.selectOption('');
			await depth.fill('17');
			await expect(depth).not.toHaveAttribute('aria-invalid');
			await expectFieldError(depth, /no greater than 16/);
		}
		await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
		await dialog.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
		await expect(dialog.locator('.field-error')).toHaveCount(0);
		if (channel) {
			await dialog.getByRole('combobox', { name: 'Audio and video settings', exact: true }).selectOption('');
			const disclosure = dialog.getByRole('button', { name: /Video & audio settings/ });
			if (await disclosure.getAttribute('aria-expanded') !== 'true') {
				await disclosure.click();
			}
		}
		await width.fill('640');
		await depth.fill('8');
		await dialog.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(dialog).toBeHidden();
	});
}
