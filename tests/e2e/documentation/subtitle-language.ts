import { expect } from '@playwright/test';
import { test } from './fixture';
import { seedSchedule } from './seed';

test('subtitle language loading protects edited values while preserving saved aliases and reset', async ({ page, documentationServer }) => {
	const { channel, requestHeaders } = await seedSchedule(page, documentationServer.directory);
	const patched = await page.request.patch(`/api/v1/channels/${channel.id}`, {
		headers: requestHeaders, data: { subtitlePreferences: { policy: 'any', language: 'ga' } },
	});
	expect(patched.ok()).toBe(true);
	await page.goto('/channels');
	await expect(page.getByRole('button', { name: 'Edit Moonrise Classics', exact: true })).toBeVisible();
	let release!: () => void;
	const pending = new Promise<void>(resolve => {
		release = resolve;
	});
	// Delay only the lazy inventory after the application has loaded.
	await page.route('**/assets/*.js', async route => {
		await pending;
		await route.continue().catch(() => {});
	});
	try {
		await page.getByRole('button', { name: 'Edit Moonrise Classics', exact: true }).click();
		const editor = page.getByRole('dialog', { name: 'Edit Channel', exact: true });
		const language = editor.getByRole('combobox', { name: 'Specific subtitle language', exact: true });
		const name = editor.getByRole('textbox', { name: 'Name', exact: true });
		const save = editor.getByRole('button', { name: 'Save', exact: true });
		const originalName = await name.inputValue();
		await expect(editor.getByText('Loading language names…', { exact: true })).toBeVisible();
		await name.fill('Subtitle loading check');
		await expect(language).toHaveValue('ga');
		await expect(save).toBeEnabled();

		await language.fill('Ga');
		await expect(save).toBeDisabled();
		await expect(editor.getByText('Waiting for language names before validating this entry.', { exact: true })).toBeVisible();
		await editor.getByRole('button', { name: 'Reset', exact: true }).click();
		await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
		await expect(name).toHaveValue(originalName);
		await expect(language).toHaveValue('ga');
		await expect(language).toHaveAttribute('aria-invalid', 'false');
		await name.fill('Subtitle loading check');
		await expect(save).toBeEnabled();

		await language.fill('eng');
		await expect(save).toBeDisabled();
		await language.fill('Ga');
		await expect(save).toBeDisabled();
		release();
		await expect(editor.getByText('Loading language names…', { exact: true })).toBeHidden();
		await expect(language).toHaveAttribute('aria-invalid', 'true');
		await expect(save).toBeDisabled();
		await language.focus();
		await editor.getByRole('option', { name: 'Irish (ga)', exact: true }).click();
		await expect(save).toBeEnabled();
		await language.fill('Ga');
		await expect(save).toBeDisabled();
		await editor.getByRole('option', { name: 'Ga (gaa)', exact: true }).click();
		await expect(language).toHaveValue('Ga (gaa)');
		await expect(save).toBeEnabled();
		await save.click();
		await expect(editor).toBeHidden();
		const channels = await (await page.request.get('/api/v1/channels')).json();
		expect(channels.find((entry: { id: string }) => entry.id === channel.id).subtitlePreferences.language).toBe('gaa');
	}
	finally {
		release();
	}
});

test('subtitle language loading cannot restore a cleared rule', async ({ page, documentationServer }) => {
	await seedSchedule(page, documentationServer.directory);
	await page.goto('/channels');
	await page.getByRole('button', { name: 'Edit Moonrise Classics', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'Edit Channel', exact: true });
	let release!: () => void;
	const pending = new Promise<void>(resolve => {
		release = resolve;
	});
	let inventoryUrl = '';
	await page.route('**/assets/*.js', async route => {
		inventoryUrl = route.request().url();
		await pending;
		await route.continue().catch(() => {});
	});
	try {
		await editor.getByRole('radio', { name: 'Any matching track', exact: true }).check();
		const mode = editor.getByRole('combobox', { name: 'Subtitle language', exact: true });
		await mode.selectOption('specific');
		await editor.getByRole('combobox', { name: 'Specific subtitle language', exact: true }).fill('English');
		await expect.poll(() => inventoryUrl).not.toBe('');
		await mode.selectOption('any');
		release();
		// Wait for the same module and its earlier loading callbacks to complete.
		await page.evaluate(async url => {
			await import(url);
		}, inventoryUrl);
		await expect(mode).toHaveValue('any');
		await expect(editor.getByRole('combobox', { name: 'Specific subtitle language', exact: true })).toHaveCount(0);
		await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	}
	finally {
		release();
	}
});
