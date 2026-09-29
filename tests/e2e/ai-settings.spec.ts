import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

const profiles = ['openai', 'anthropic', 'xai', 'openrouter', 'custom'].map(provider => ({
	provider, hasKey: false, keyPlaceholder: null, modelOverride: null, effectiveModel: provider === 'openai' ? 'gpt-6-sol' : 'recommended',
	webSearch: false, researchAvailable: true,
	...(provider === 'custom' ? { baseUrl: '', protocol: 'chat-completions', chatJsonMode: 'json_object' } : {}),
}));

test('offers web research for each provider and Custom Messages format', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.route('**/api/v1/ai/settings', async route => {
		await route.fulfill({ json: { activeProvider: null, profiles, connectionWarning: null } });
	});
	await page.goto('/settings');
	for (const provider of ['openai', 'anthropic', 'xai', 'openrouter']) {
		await page.getByRole('combobox', { name: 'Provider' }).selectOption(provider);
		await page.getByText('Advanced', { exact: true }).click();
		await expect(page.getByLabel('Use web research when generating')).toBeVisible();
		await page.getByText('Advanced', { exact: true }).click();
	}
	await page.getByRole('combobox', { name: 'Provider' }).selectOption('custom');
	await page.getByText('Advanced', { exact: true }).click();
	await page.getByLabel('API format').selectOption('anthropic-messages');
	await expect(page.getByLabel('Use web research when generating')).toBeVisible();
	await page.getByLabel('Use web research when generating').check();
	await expect(page.getByRole('combobox', { name: /Web research time limit/u })).toHaveValue('7');
	await page.getByRole('combobox', { name: /Web research time limit/u }).selectOption('10');
	await expect(page.getByRole('combobox', { name: /Web research time limit/u })).toHaveValue('10');
});

test('loads AI Settings, keeps Save errors and warnings visible, and protects an unsaved draft', async ({ page }) => {
	await authenticateAdministrator(page);
	let loadFails = true;
	await page.route('**/api/v1/ai/settings', async route => {
		if (route.request().method() === 'GET' && loadFails) {
			await route.fulfill({ status: 503, json: { message: 'Settings unavailable' } });
			return;
		}
		if (route.request().method() === 'PUT') {
			const body = route.request().postDataJSON();
			await route.fulfill({ json: { activeProvider: body.activeProvider, profiles: profiles.map(profile => profile.provider === body.activeProvider
				? { ...profile, hasKey: true, keyPlaceholder: '••••••' } : profile), connectionWarning: 'Connection not verified. Try generating later.' } });
			return;
		}
		await route.fulfill({ json: { activeProvider: null, profiles, connectionWarning: null } });
	});
	await page.goto('/settings');
	await expect(page.getByText('Settings unavailable')).toBeVisible();
	loadFails = false;
	await page.getByRole('button', { name: 'Retry AI Settings' }).click();
	await expect(page.getByRole('heading', { name: 'AI provider' })).toBeVisible();
	await expect(page.getByText('AI is off. Saving a provider enables it.')).toBeVisible();
	await page.getByLabel('API Key').fill('test-key');
	await page.getByRole('button', { name: 'Save AI Settings' }).click();
	await expect(page.getByText('Connection not verified. Try generating later.')).toBeVisible();
	await expect(page.getByText('A key is saved for this provider.')).toBeVisible();
	await expect(page.getByLabel('API Key')).toHaveAttribute('placeholder', '••••••');
	await page.getByLabel('API Key').fill('replacement-key');
	await page.getByRole('combobox', { name: 'Provider' }).selectOption('xai');
	await expect(page.getByRole('alertdialog', { name: 'Discard Provider Changes?' })).toBeVisible();
	await page.getByRole('alertdialog', { name: 'Discard Provider Changes?' }).getByRole('button', { name: 'Keep Editing' }).click();
	await expect(page.getByLabel('API Key')).toHaveValue('replacement-key');
	await page.getByRole('link', { name: 'Quick Setup' }).click();
	await expect(page.getByRole('alertdialog', { name: 'Discard Unsaved Changes?' })).toBeVisible();
});

test('clears the draft after saving normalized Custom settings', async ({ page }) => {
	await authenticateAdministrator(page);
	let current = { activeProvider: null as string | null, profiles, connectionWarning: null };
	await page.route('**/api/v1/ai/settings', async route => {
		if (route.request().method() === 'PUT') {
			const body = route.request().postDataJSON();
			current = { activeProvider: body.activeProvider, connectionWarning: null,
				profiles: profiles.map(profile => profile.provider === 'custom' ? {
					...profile, modelOverride: body.profile.modelOverride,
					effectiveModel: body.profile.modelOverride, baseUrl: 'https://example.test/v1',
				} : profile) };
		}
		await route.fulfill({ json: current });
	});
	await page.goto('/settings');
	await page.getByRole('combobox', { name: 'Provider' }).selectOption('custom');
	await page.getByText('Advanced', { exact: true }).click();
	await page.getByLabel('Custom model ID').fill('  local-model  ');
	await page.getByLabel('Endpoint base URL').fill('https://example.test/v1/');
	await page.getByRole('button', { name: 'Save AI Settings' }).click();
	await expect(page.getByLabel('Custom model ID')).toHaveValue('local-model');
	await expect(page.getByLabel('Endpoint base URL')).toHaveValue('https://example.test/v1');
	await expect(page.getByRole('button', { name: 'Save AI Settings' })).toBeDisabled();
	await page.getByRole('link', { name: 'Quick Setup' }).click();
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('confirms before permanently forgetting a provider key', async ({ page }) => {
	await authenticateAdministrator(page);
	let removals = 0;
	await page.route('**/api/v1/ai/settings', async route => {
		await route.fulfill({ json: { activeProvider: 'openai', profiles: profiles.map(profile => profile.provider === 'openai'
			? { ...profile, hasKey: removals === 0, keyPlaceholder: removals === 0 ? 'sk-12...abcd' : null } : profile), connectionWarning: null } });
	});
	await page.route('**/api/v1/ai/settings/openai/key', async route => {
		removals += 1;
		await route.fulfill({ json: { activeProvider: null, profiles, connectionWarning: null } });
	});
	await page.goto('/settings');
	await expect(page.getByLabel('API Key')).toHaveAttribute('placeholder', 'sk-12...abcd');
	await page.getByRole('button', { name: 'Forget key' }).click();
	const confirmation = page.getByRole('alertdialog', { name: 'Forget Provider Key?' });
	await expect(confirmation).toBeVisible();
	await confirmation.getByRole('button', { name: 'Keep Key' }).click();
	expect(removals).toBe(0);
	await page.getByRole('button', { name: 'Forget key' }).click();
	await confirmation.getByRole('button', { name: 'Forget Key' }).click();
	await expect(page.getByRole('button', { name: 'Forget key' })).toBeHidden();
	expect(removals).toBe(1);
});
