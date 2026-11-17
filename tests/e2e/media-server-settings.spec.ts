import { expect, test } from '@playwright/test';
import type { MediaServer } from '@moirai/shared';
import { authenticateAdministrator } from './authentication';

const server: MediaServer = {
	id: '11111111-1111-4111-8111-111111111111', provider: 'jellyfin', name: 'Living room',
	baseUrl: 'https://media.example', serverKey: 'test-server', serverName: 'Jellyfin',
	clientIdentifier: 'test-client', hasCredential: true, credentialPlaceholder: 'Saved API key',
	createdAt: '2026-01-15T00:00:00.000Z', updatedAt: '2026-01-15T00:00:00.000Z',
	allowInsecureTls: false, playbackReportingEnabled: false, pathReplacements: [],
};

test('distinguishes initial loading, failed loading, and empty media-server settings', async ({ page }) => {
	await authenticateAdministrator(page);
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let first = true;
	await page.route('**/api/v1/media-servers', async (route) => {
		if (first) {
			await pending;
			first = false;
			await route.fulfill({ status: 500, json: { message: 'Synthetic load failure', code: 'request_failed', requestId: 'test' } });
			return;
		}

		await route.fulfill({ json: [] });
	});
	await page.goto('/settings');
	const mediaServers = page.getByRole('tab', { name: /^Media Servers/ });
	await expect(page.getByRole('tab')).toHaveText(['Playback', 'Media Servers', 'AI', 'Backups']);
	await expect(page.getByRole('region', { name: 'Media library servers', exact: true })).toBeHidden();
	await page.getByRole('tab', { name: /^Playback/ }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(mediaServers).toBeFocused();
	await expect(page).toHaveURL(/\/settings\/media-servers$/);
	const panel = page.getByRole('region', { name: 'Media library servers', exact: true });
	await expect(panel.getByText('Loading media servers…', { exact: true })).toBeVisible();
	await expect(panel.getByText('No media servers saved yet.', { exact: true })).toHaveCount(0);
	release();
	await expect(panel.getByRole('alert')).toContainText('Synthetic load failure');
	await expect(mediaServers).toHaveAccessibleName(/Needs attention/);
	await expect(page.getByRole('tab', { name: /^Playback/ })).not.toHaveAccessibleName(/Needs attention/);
	await expect(panel.getByText('No media servers saved yet.', { exact: true })).toHaveCount(0);
	await panel.getByRole('button', { name: 'Retry Media Servers', exact: true }).click();
	await expect(panel.getByText('No media servers saved yet.', { exact: true })).toBeVisible();
	await expect(mediaServers).not.toHaveAccessibleName(/Needs attention/);
});

test('adds, edits, resets, and deletes a saved media server with draft protection', async ({ page }) => {
	await authenticateAdministrator(page);
	let saved: MediaServer | null = null;
	let created: Record<string, unknown> | undefined;
	let updated: Record<string, unknown> | undefined;
	let deletes = 0;
	await page.route('**/api/v1/media-servers', async (route) => {
		if (route.request().method() === 'POST') {
			created = route.request().postDataJSON();
			saved = { ...server, name: String(created!.name), playbackReportingEnabled: Boolean(created!.playbackReportingEnabled) };
			await route.fulfill({ status: 201, json: saved });
			return;
		}

		await route.fulfill({ json: saved ? [saved] : [] });
	});
	await page.route(`**/api/v1/media-servers/${server.id}`, async (route) => {
		if (route.request().method() === 'DELETE') {
			deletes += 1;
			saved = null;
			await route.fulfill({ status: 204 });
			return;
		}

		updated = route.request().postDataJSON();
		saved = { ...server, name: String(updated!.name), playbackReportingEnabled: Boolean(updated!.playbackReportingEnabled) };
		await route.fulfill({ json: saved });
	});
	await page.goto('/settings/media-servers');
	const panel = page.getByRole('region', { name: 'Media library servers', exact: true });
	await panel.getByRole('button', { name: 'Add Media Server', exact: true }).click();
	let editor = page.getByRole('dialog', { name: 'Add Media Server', exact: true });
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	const advanced = editor.getByRole('button', { name: 'Advanced', exact: true });
	const addMapping = editor.getByRole('button', { name: 'Add folder mapping', exact: true });
	await expect(addMapping).toBeHidden();
	await advanced.focus();
	await advanced.press('Enter');
	await expect(advanced).toHaveAttribute('aria-expanded', 'true');
	await expect(addMapping).toBeVisible();
	await advanced.press('Space');
	await expect(advanced).toHaveAttribute('aria-expanded', 'false');
	await expect(addMapping).toBeHidden();
	await expect(advanced).toBeFocused();
	await editor.getByRole('radio', { name: 'Jellyfin', exact: true }).click();
	const reporting = page.getByRole('switch', { name: /Report channel playback to Jellyfin/ });
	await expect(reporting).not.toBeChecked();
	await reporting.check();
	await editor.getByLabel('Server name', { exact: true }).fill('Living room');
	await editor.getByLabel('Server address', { exact: true }).fill(server.baseUrl);
	await editor.getByRole('combobox', { name: 'Authentication method', exact: true }).selectOption('key');
	await editor.getByLabel('API key', { exact: true }).fill('synthetic-token');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toBeHidden();
	expect(created).toMatchObject({ provider: 'jellyfin', name: 'Living room', baseUrl: server.baseUrl, accessToken: 'synthetic-token', playbackReportingEnabled: true });
	await expect(panel.getByText('Living room', { exact: true })).toBeVisible();
	await panel.getByRole('button', { name: 'Edit media server Living room', exact: true }).click();
	editor = page.getByRole('dialog', { name: 'Edit Media Server', exact: true });
	await expect(editor.getByRole('combobox', { name: 'Authentication method', exact: true })).toHaveValue('saved');
	await expect(reporting).toBeChecked();
	await expect(editor.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
	await editor.getByLabel('Server name', { exact: true }).fill('Unsaved name');
	await expect(page.getByRole('tab', { name: /^Media Servers/ })).toHaveAccessibleName(/Unsaved changes/);
	await expect(page.getByRole('tab', { name: /^Playback/ })).not.toHaveAccessibleName(/Unsaved changes/);
	await editor.getByRole('button', { name: 'Close media server editor', exact: true }).click();
	const unsaved = page.getByRole('alertdialog', { name: 'Save Changes?', exact: true });
	await expect(unsaved).toBeVisible();
	await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click();
	await editor.getByRole('button', { name: 'Reset', exact: true }).click();
	await expect(editor.getByLabel('Server name', { exact: true })).toHaveValue('Unsaved name');
	await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(editor.getByLabel('Server name', { exact: true })).toHaveValue('Living room');
	await expect(reporting).toBeChecked();
	await reporting.uncheck();
	await editor.getByLabel('Server name', { exact: true }).fill('Renamed server');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toBeHidden();
	expect(updated).toMatchObject({ name: 'Renamed server', accessToken: '', playbackReportingEnabled: false });
	await panel.getByRole('button', { name: 'Edit media server Renamed server', exact: true }).click();
	await editor.getByRole('button', { name: 'Delete Media Server', exact: true }).click();
	const confirmation = page.getByRole('alertdialog', { name: 'Delete Media Server?', exact: true });
	await expect(confirmation).toBeVisible();
	expect(deletes).toBe(0);
	await confirmation.getByRole('button', { name: 'Delete Media Server', exact: true }).click();
	await expect(editor).toBeHidden();
	expect(deletes).toBe(1);
	await expect(panel.getByText('No media servers saved yet.', { exact: true })).toBeVisible();
});

test('keeps in-use deletion failures in the editor and fits desktop and phone screens', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.route('**/api/v1/media-servers', (route) => route.fulfill({ json: [server] }));
	await page.route(`**/api/v1/media-servers/${server.id}`, (route) => route.fulfill({ status: 409, json: { message: 'A library uses this server', code: 'conflict', requestId: 'test' } }));
	await page.goto('/settings/media-servers');
	const panel = page.getByRole('region', { name: 'Media library servers', exact: true });
	await panel.scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'test-results/media-server-settings-desktop.png', fullPage: true });
	await panel.getByRole('button', { name: 'Edit media server Living room', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'Edit Media Server', exact: true });
	await editor.getByRole('button', { name: 'Delete Media Server', exact: true }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Media Server', exact: true }).click();
	await expect(editor.getByRole('alert')).toContainText('A library uses this server');
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
	await expect(editor.getByRole('button', { name: 'Close media server editor', exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.screenshot({ path: 'test-results/media-server-settings-phone.png', fullPage: true });
});

test('tests edited server connection values without saving and restores authentication on Reset', async ({ page }) => {
	await authenticateAdministrator(page);
	let probes = 0;
	let writes = 0;
	await page.route('**/api/v1/media-servers', (route) => route.fulfill({ json: [server] }));
	await page.route(`**/api/v1/media-servers/${server.id}`, async (route) => {
		writes += 1;
		await route.fulfill({ json: server });
	});
	await page.route(`**/api/v1/media-servers/${server.id}/probe`, async (route) => {
		probes += 1;
		expect(route.request().postDataJSON()).toMatchObject({ baseUrl: 'https://edited.example', accessToken: 'synthetic-replacement-key', allowInsecureTls: true });
		await route.fulfill({ json: { serverKey: server.serverKey, serverName: server.serverName, libraries: [] } });
	});
	await page.goto('/settings/media-servers');
	const panel = page.getByRole('region', { name: 'Media library servers', exact: true });
	await panel.getByRole('button', { name: 'Edit media server Living room', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'Edit Media Server', exact: true });
	await editor.getByLabel('Server address', { exact: true }).fill('https://edited.example');
	await editor.getByRole('switch', { name: /Allow untrusted certificate/ }).check();
	await editor.getByRole('combobox', { name: 'Authentication method', exact: true }).selectOption('key');
	await editor.getByLabel('API key', { exact: true }).fill('synthetic-replacement-key');
	await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Media server connection successful.' })).toBeVisible();
	await expect(editor.locator('.notice.warning')).toContainText('untrusted certificate');
	expect(probes).toBe(1);
	expect(writes).toBe(0);
	await page.mouse.move(0, 0);
	await expect(page.getByRole('status').filter({ hasText: 'Media server connection successful.' })).toBeHidden();
	await editor.getByRole('button', { name: 'Reset', exact: true }).click();
	await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(editor.getByLabel('Server address', { exact: true })).toHaveValue(server.baseUrl);
	await expect(editor.getByRole('combobox', { name: 'Authentication method', exact: true })).toHaveValue('saved');
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('copies the Plex link code while polling and accepts the credential for connection testing', async ({ page }, testInfo) => {
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	await authenticateAdministrator(page);
	await page.route('**/api/v1/media-servers', route => route.fulfill({ json: [] }));
	let authorized = false;
	const clientIdentifier = 'moirai-plex-link-test';
	await page.route('**/api/v1/media-servers/plex/pin', route => route.fulfill({
		status: 201, json: { pinId: 123, code: 'ABCD', clientIdentifier },
	}));
	await page.route('**/api/v1/media-servers/plex/pin/123**', async (route) => {
		expect(new URL(route.request().url()).searchParams.get('clientIdentifier')).toBe(clientIdentifier);
		expect(new URL(route.request().url()).searchParams.get('baseUrl')).toBe('http://plex.example:32400');
		await route.fulfill({ json: { accessToken: authorized ? 'synthetic-plex-access-token' : null, clientIdentifier } });
	});
	let tested = false;
	await page.route('**/api/v1/media-servers/probe', async (route) => {
		expect(route.request().postDataJSON()).toMatchObject({ provider: 'plex', accessToken: 'synthetic-plex-access-token', clientIdentifier });
		tested = true;
		await route.fulfill({ json: { serverKey: 'plex-server', serverName: 'Test Plex', libraries: [] } });
	});
	await page.goto('/settings/media-servers');
	await page.getByRole('button', { name: 'Add Media Server', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'Add Media Server', exact: true });
	await editor.getByRole('radio', { name: 'Plex', exact: true }).click();
	const method = editor.getByRole('combobox', { name: 'Authentication method', exact: true });
	await expect(method).toHaveValue('plex-sign-in');
	await expect(editor.getByLabel('Plex token', { exact: true })).toHaveCount(0);
	await editor.getByLabel('Server address', { exact: true }).fill('http://plex.example:32400');
	await expect(editor.getByRole('button', { name: 'Test connection', exact: true })).toBeDisabled();
	await editor.getByRole('button', { name: 'Sign in with Plex', exact: true }).click();
	const code = editor.getByRole('textbox', { name: 'Plex link code', exact: true });
	await expect(code).toHaveValue('ABCD');
	await expect(code).toHaveJSProperty('readOnly', true);
	await expect(editor.getByRole('link', { name: 'plex.tv/link', exact: true })).toHaveAttribute('href', 'https://plex.tv/link');
	const copy = editor.getByRole('button', { name: 'Copy Plex link code', exact: true });
	await expect(editor.getByRole('button', { name: 'Waiting for Plex…', exact: true })).toBeDisabled();
	await expect(copy).toBeEnabled();
	await copy.click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('ABCD');
	await expect(editor.getByRole('status')).toContainText('Plex link code copied');
	await editor.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
	await expect(editor.getByRole('status')).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath('plex-code-desktop.png') });

	await page.setViewportSize({ width: 390, height: 844 });
	await code.scrollIntoViewIfNeeded();
	await expect(copy).toBeInViewport();
	await expect(code).toBeInViewport();
	await page.screenshot({ path: testInfo.outputPath('plex-code-phone.png') });


	authorized = true;
	await expect(editor.getByRole('status')).toContainText('Signed in with Plex.');
	await expect(editor.getByLabel('Plex token', { exact: true })).toHaveCount(0);
	await expect(code).toHaveCount(0);
	await expect(copy).toHaveCount(0);
	await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
	await expect(editor.getByLabel('Server name', { exact: true })).toHaveValue('Test Plex');
	expect(tested).toBe(true);

	// A manually supplied replacement must not inherit the issued token's invalidation state.
	await method.selectOption('key');
	const token = editor.getByLabel('Plex token', { exact: true });
	await expect(token).toHaveValue('');
	await expect(editor.getByRole('button', { name: 'Sign in with Plex', exact: true })).toHaveCount(0);
	await token.fill('synthetic-manual-token');
	await page.setViewportSize({ width: 1440, height: 900 });
	await token.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath('plex-token-desktop.png') });
	await editor.getByLabel('Server address', { exact: true }).fill('http://replacement.example:32400');
	await expect(token).toHaveValue('synthetic-manual-token');
	await editor.getByRole('button', { name: 'Reset', exact: true }).click();
	await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(method).toHaveValue('plex-sign-in');
	await expect(token).toHaveCount(0);
	await expect(editor.getByRole('button', { name: 'Sign in with Plex', exact: true })).toBeVisible();
});

test('keeps manual Plex tokens when an earlier sign-in response arrives after switching methods', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.route('**/api/v1/media-servers', route => route.fulfill({ json: [] }));
	await page.route('**/api/v1/media-servers/plex/pin', route => route.fulfill({
		status: 201, json: { pinId: 456, code: 'EFGH', clientIdentifier: 'plex-pending-client' },
	}));
	let release!: () => void;
	const pending = new Promise<void>(resolve => {
		release = resolve;
	});
	let started!: () => void;
	const polling = new Promise<void>(resolve => {
		started = resolve;
	});
	await page.route('**/api/v1/media-servers/plex/pin/456**', async (route) => {
		started();
		await pending;
		await route.fulfill({ json: { accessToken: 'synthetic-late-token', clientIdentifier: 'plex-pending-client' } });
	});
	await page.route('**/api/v1/media-servers/probe', async (route) => {
		expect(route.request().postDataJSON()).toMatchObject({ accessToken: 'synthetic-manual-token' });
		await route.fulfill({ json: { serverKey: 'manual-server', serverName: 'Manual Plex', libraries: [] } });
	});
	await page.goto('/settings/media-servers');
	await page.getByRole('button', { name: 'Add Media Server', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'Add Media Server', exact: true });
	await editor.getByLabel('Server address', { exact: true }).fill('https://plex.example');
	await editor.getByRole('button', { name: 'Sign in with Plex', exact: true }).click();
	await polling;
	const method = editor.getByRole('combobox', { name: 'Authentication method', exact: true });
	await method.selectOption('key');
	await expect(editor.getByLabel('Plex link code', { exact: true })).toHaveCount(0);
	await expect(editor.getByRole('button', { name: 'Test connection', exact: true })).toBeDisabled();
	const token = editor.getByLabel('Plex token', { exact: true });
	await token.fill('synthetic-manual-token');
	const lateResponse = page.waitForResponse('**/api/v1/media-servers/plex/pin/456**');
	release();
	await lateResponse;
	await expect(token).toHaveValue('synthetic-manual-token');
	await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
	await expect(editor.getByLabel('Server name', { exact: true })).toHaveValue('Manual Plex');
	await method.selectOption('plex-sign-in');
	await expect(token).toHaveCount(0);
	await expect(editor.getByRole('button', { name: 'Sign in with Plex', exact: true })).toBeVisible();
	await expect(editor.getByRole('button', { name: 'Test connection', exact: true })).toBeDisabled();
});


test('saves and resets Plex reporting and clears the opt-in when switching providers', async ({ page }) => {
	await authenticateAdministrator(page);
	let saved: MediaServer | null = null;
	const writes: Record<string, unknown>[] = [];
	await page.route('**/api/v1/media-servers', async (route) => {
		if (route.request().method() === 'POST') {
			const input = route.request().postDataJSON();
			writes.push(input);
			saved = { ...server, provider: 'plex', name: 'Plex reporting', playbackReportingEnabled: input.playbackReportingEnabled };
			await route.fulfill({ status: 201, json: saved });
			return;
		}
		await route.fulfill({ json: saved ? [saved] : [] });
	});
	await page.route(`**/api/v1/media-servers/${server.id}`, async (route) => {
		const input = route.request().postDataJSON();
		writes.push(input);
		saved = { ...saved!, playbackReportingEnabled: input.playbackReportingEnabled };
		await route.fulfill({ json: saved });
	});
	await page.goto('/settings/media-servers');
	const panel = page.getByRole('region', { name: 'Media library servers', exact: true });
	await panel.getByRole('button', { name: 'Add Media Server', exact: true }).click();
	const editor = page.getByRole('dialog');
	await editor.getByRole('radio', { name: 'Plex', exact: true }).click();
	const reporting = editor.getByRole('switch', { name: /Report channel playback to Plex/ });
	await expect(reporting).not.toBeChecked();
	await reporting.check();
	await editor.getByRole('radio', { name: 'Emby', exact: true }).click();
	await expect(editor.getByRole('switch', { name: /Report channel playback/ })).toHaveCount(0);
	await editor.getByRole('radio', { name: 'Plex', exact: true }).click();
	await expect(reporting).not.toBeChecked();
	await reporting.check();
	await editor.getByLabel('Server name', { exact: true }).fill('Plex reporting');
	await editor.getByLabel('Server address', { exact: true }).fill(server.baseUrl);
	await editor.getByRole('combobox', { name: 'Authentication method', exact: true }).selectOption('key');
	await editor.getByLabel('Plex token', { exact: true }).fill('synthetic-token');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toBeHidden();
	expect(writes[0]).toMatchObject({ provider: 'plex', playbackReportingEnabled: true });
	await panel.getByRole('button', { name: 'Edit media server Plex reporting', exact: true }).click();
	await expect(reporting).toBeChecked();
	await reporting.uncheck();
	await editor.getByRole('button', { name: 'Reset', exact: true }).click();
	await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(reporting).toBeChecked();
	await reporting.uncheck();
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toBeHidden();
	expect(writes[1]).toMatchObject({ provider: 'plex', playbackReportingEnabled: false });
});


test('requires fresh sign-in for a restored media-server definition without a credential', async ({ page }) => {
	await authenticateAdministrator(page);
	const restored = { ...server, provider: 'plex' as const, name: 'Restored Plex', hasCredential: false, credentialPlaceholder: null };
	let update: Record<string, unknown> | undefined;
	await page.route('**/api/v1/media-servers', route => route.fulfill({ json: [restored] }));
	await page.route(`**/api/v1/media-servers/${server.id}`, async route => {
		update = route.request().postDataJSON();
		await route.fulfill({ json: { ...restored, hasCredential: true } });
	});
	await page.goto('/settings/media-servers');
	await page.getByRole('button', { name: 'Edit media server Restored Plex', exact: true }).click();
	const editor = page.getByRole('dialog');
	const method = editor.getByRole('combobox', { name: 'Authentication method', exact: true });
	await expect(method).toHaveValue('plex-sign-in');
	await expect(method.getByRole('option', { name: 'Keep saved credential', exact: true })).toHaveCount(0);
	await editor.getByLabel('Server name', { exact: true }).fill('Restored Plex edited');
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await method.selectOption('key');
	await editor.getByLabel('Plex token', { exact: true }).fill('synthetic-relinked-token');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toBeHidden();
	expect(update).toMatchObject({ accessToken: 'synthetic-relinked-token' });
});
