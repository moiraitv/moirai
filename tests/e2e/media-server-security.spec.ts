import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('keeps insecure media-server warnings visible before connecting or signing in', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.route('**/api/v1/media-servers', (route) => route.fulfill({ json: [] }));
	await page.route('**/api/v1/media-servers/probe', (route) => route.fulfill({ status: 400, json: { code: 'request_failed', message: 'Synthetic connection failure', requestId: 'audit' } }));
	await page.goto('/libraries');
	await page.getByRole('button', { name: 'Add Library', exact: true }).first().click();
	const editor = page.getByRole('dialog');
	await editor.getByRole('radio', { name: 'Plex', exact: true }).click();
	const address = editor.getByLabel('Server address', { exact: true });
	await address.fill('http://media.example:32400');
	const warning = editor.locator('.notice.warning');
	await expect(warning).toContainText('HTTP');
	await expect(warning).toContainText('token or API key');
	await editor.getByRole('combobox', { name: 'Authentication method', exact: true }).selectOption('key');
	await editor.locator('input[type="password"]').first().fill('synthetic-e2e-token');
	await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
	await expect(editor.getByRole('alert').filter({ hasText: 'Synthetic connection failure' })).toBeVisible();
	await expect(warning).toBeVisible();
	await address.fill('http://127.0.0.1:32400');
	await expect(warning).toHaveCount(0);
	await address.fill('https://media.example:32400');
	await expect(warning).toHaveCount(0);
	await editor.getByRole('switch', { name: /Allow untrusted certificate/ }).check();
	await expect(warning).toContainText('untrusted certificate');
	await editor.getByRole('radio', { name: 'Jellyfin', exact: true }).click();
	await address.fill('http://media.example:8096');
	await expect(warning).toContainText('password used to sign in');
	await expect(editor.getByRole('button', { name: 'Test connection', exact: true })).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await warning.scrollIntoViewIfNeeded();
	await expect(warning).toBeVisible();
	await page.screenshot({ path: 'test-results/media-server-security-warning.png', fullPage: true });
});

test('requires a fresh remote library when switching saved servers after a connection failure', async ({ page }) => {
	await authenticateAdministrator(page);
	const first = '11111111-1111-4111-8111-111111111111';
	const second = '22222222-2222-4222-8222-222222222222';
	await page.route('**/api/v1/media-servers', (route) => route.fulfill({ json: [first, second].map((id, index) => ({
		id, provider: 'plex', name: `Server ${index + 1}`, serverName: 'Plex', serverKey: id,
		baseUrl: `https://server-${index + 1}.example`, hasAccessToken: true, allowInsecureTls: false, pathReplacements: [],
	})) }));
	await page.route(`**/api/v1/media-servers/${first}/probe`, (route) => route.fulfill({ json: { serverKey: first, serverName: 'Plex', libraries: [{ id: 'only-on-first', name: 'Movies A', typeKey: 'movies' }] } }));
	await page.route(`**/api/v1/media-servers/${second}/probe`, (route) => route.fulfill({ status: 400, json: { code: 'request_failed', message: 'Synthetic server B failure', requestId: 'audit' } }));
	await page.goto('/libraries');
	await page.getByRole('button', { name: 'Add Library', exact: true }).first().click();
	const editor = page.getByRole('dialog');
	await editor.getByLabel('Name', { exact: true }).fill('Server switch regression');
	await editor.getByRole('radio', { name: 'Plex', exact: true }).click();
	await expect(editor.getByRole('combobox', { name: /^Remote library/ })).toHaveValue('only-on-first');
	const save = editor.getByRole('button', { name: 'Add and Scan', exact: true });
	await expect(save).toBeEnabled();
	await editor.getByRole('combobox', { name: 'Server', exact: true }).selectOption(second);
	await expect(save).toBeDisabled();
	await expect(editor.getByRole('alert').filter({ hasText: 'Synthetic server B failure' })).toBeVisible();
	await expect(save).toBeDisabled();
	await editor.getByRole('combobox', { name: 'Server', exact: true }).selectOption(first);
	await expect(editor.getByRole('combobox', { name: /^Remote library/ })).toHaveValue('only-on-first');
	await expect(save).toBeEnabled();
});

test('restores the saved connection after discarding a new server draft', async ({ page }) => {
	await authenticateAdministrator(page);
	const id = '11111111-1111-4111-8111-111111111111';
	await page.route('**/api/v1/media-servers', (route) => route.fulfill({ json: [{
		id, provider: 'plex', name: 'Saved connection', serverName: 'Plex', serverKey: id,
		baseUrl: 'https://saved.example', clientIdentifier: 'saved-client', hasAccessToken: true,
		allowInsecureTls: false, pathReplacements: [],
	}] }));
	await page.route(`**/api/v1/media-servers/${id}/probe`, (route) => route.fulfill({ json: { serverKey: id, serverName: 'Plex', libraries: [{ id: 'movies', name: 'Saved Movies', typeKey: 'movies' }] } }));
	await page.goto('/libraries/new');
	const editor = page.getByRole('dialog');
	await editor.getByLabel('Name', { exact: true }).fill('Restored library');
	await editor.getByRole('radio', { name: 'Plex', exact: true }).click();
	await expect(editor.getByRole('combobox', { name: 'Remote library', exact: true })).toHaveValue('movies');
	await editor.getByRole('combobox', { name: 'Server', exact: true }).selectOption('new');
	await editor.getByLabel('Server address', { exact: true }).fill('https://draft.example');
	await editor.getByRole('combobox', { name: 'Authentication method', exact: true }).selectOption('key');
	await editor.getByLabel('Plex token', { exact: true }).fill('synthetic-draft-token');
	await editor.getByRole('combobox', { name: 'Server', exact: true }).selectOption(id);
	await expect(editor.getByLabel('Server address', { exact: true })).toHaveValue('https://saved.example');
	await expect(editor.getByRole('combobox', { name: 'Authentication method', exact: true })).toHaveValue('saved');
	await expect(editor.getByLabel('Server name', { exact: true })).toHaveValue('Saved connection');
	await expect(editor.getByRole('combobox', { name: 'Remote library', exact: true })).toHaveValue('movies');
	await expect(editor.getByRole('button', { name: 'Add and Scan', exact: true })).toBeEnabled();
});

for (const failure of ['password', 'pin creation', 'pin polling'] as const) {
	test(`shows initial ${failure} failures in the library editor`, async ({ page }) => {
		await authenticateAdministrator(page);
		await page.route('**/api/v1/media-servers', (route) => route.fulfill({ json: [] }));
		const error = { code: 'request_failed', message: 'Synthetic credential failure', requestId: 'audit' };
		await page.route('**/api/v1/media-servers/session', (route) => route.fulfill({ status: 400, json: error }));
		await page.route('**/api/v1/media-servers/plex/pin', (route) => route.fulfill(failure === 'pin creation'
			? { status: 400, json: error }
			: { json: { pinId: 123, code: 'TEST', clientIdentifier: 'synthetic-client' } }));
		await page.route('**/api/v1/media-servers/plex/pin/123?*', (route) => route.fulfill({ status: 400, json: error }));
		await page.goto('/libraries/new');
		const editor = page.getByRole('dialog');
		await editor.getByRole('radio', { name: failure === 'password' ? 'Jellyfin' : 'Plex', exact: true }).click();
		await editor.getByLabel('Server address', { exact: true }).fill('https://media.example');
		if (failure === 'password') {
			await editor.getByLabel('Username', { exact: true }).fill('synthetic-user');
			await editor.getByLabel(/^Password/).fill('synthetic-password');
			await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
		}
		else {
			await editor.getByRole('button', { name: 'Sign in with Plex', exact: true }).click();
		}

		await expect(editor.getByRole('alert').filter({ hasText: error.message })).toBeVisible();
	});
}
