import { expect, test, type Page } from '@playwright/test';
import type { MediaServer } from '@moirai/shared';
import { authenticateAdministrator } from './authentication';

const savedServer: MediaServer = {
	id: '11111111-1111-4111-8111-111111111111', provider: 'jellyfin', name: 'Living room',
	baseUrl: 'https://media.example', serverKey: 'test-server', serverName: 'Jellyfin',
	clientIdentifier: 'test-client', hasCredential: true, credentialPlaceholder: 'Saved API key',
	createdAt: '2026-01-15T00:00:00.000Z', updatedAt: '2026-01-15T00:00:00.000Z',
	allowInsecureTls: false, playbackReportingEnabled: false, pathReplacements: [],
};
const movies = [{ id: 'films', name: 'Films', typeKey: 'movies' }];

async function openLibrary(page: Page) {
	await authenticateAdministrator(page);
	await page.route('**/api/v1/media-servers', (route) => route.fulfill({ json: [] }));
	await page.goto('/libraries/new');
	const editor = page.getByRole('dialog', { name: 'Add Library', exact: true });
	await editor.getByLabel('Name', { exact: true }).fill('My Movies');
	return editor;
}

for (const provider of ['Jellyfin', 'Emby'] as const) {
	test(`signs into ${provider} and discovers libraries without saving until Add and Scan`, async ({ page }) => {
		const editor = await openLibrary(page);
		let signIns = 0;
		let serverWrites = 0;
		let libraryWrites = 0;
		const libraryId = '22222222-2222-4222-8222-222222222222';
		const library = {
			id: libraryId, name: 'My Movies', typeKey: 'movies', sourceType: provider.toLowerCase(),
			sourceConfig: { mediaServerId: savedServer.id, remoteLibraryId: 'films', remoteLibraryName: 'Films' },
			scanIntervalMinutes: 15, watcherEnabled: false, enabled: true, watcherStatus: 'stopped',
			sourceAvailability: 'available', sourceAvailabilityUpdatedAt: null, reconciliationStatus: 'idle',
			pendingRemovalCount: 0, itemCount: 0, warningCount: 0,
			lastScanStartedAt: null, lastScanCompletedAt: null, lastChangeDetectedAt: null, lastIndexedChangeAt: null,
			createdAt: savedServer.createdAt, updatedAt: savedServer.updatedAt,
		};
		await page.route(`**/api/v1/libraries/${libraryId}`, route => route.fulfill({ json: library }));
		await page.route(`**/api/v1/libraries/${libraryId}/**`, async (route) => {
			const pathname = new URL(route.request().url()).pathname;
			await route.fulfill({ json: pathname.endsWith('/reconciliation')
				? { libraryId, status: 'idle', pendingRemovalCount: 0, missingItems: [], sourceChangeCanBeCancelled: false }
				: pathname.endsWith('/media') ? { entries: [], groups: [], items: [], navigation: [], pagination: { page: 1, pageSize: 100, totalEntries: 0, totalPages: 0 } } : [] });
		});
		await page.route('**/api/v1/media-servers/session', async (route) => {
			signIns += 1;
			expect(route.request().postDataJSON()).toMatchObject({ provider: provider.toLowerCase(), username: 'admin', password: 'synthetic-password' });
			await route.fulfill({ json: { accessToken: 'synthetic-issued-token', clientIdentifier: 'test-client' } });
		});
		await page.route('**/api/v1/media-servers/probe', async (route) => {
			expect(route.request().postDataJSON()).toMatchObject({ accessToken: 'synthetic-issued-token' });
			await route.fulfill({ json: { serverKey: savedServer.serverKey, serverName: savedServer.serverName, libraries: movies } });
		});
		await page.route(`**/api/v1/media-servers/${savedServer.id}/probe`, route => route.fulfill({ json: { serverKey: savedServer.serverKey, serverName: savedServer.serverName, libraries: movies } }));
		await page.route('**/api/v1/media-servers', async (route) => {
			if (route.request().method() === 'POST') {
				serverWrites += 1;
				await route.fulfill({ status: 201, json: { ...savedServer, provider: provider.toLowerCase() } });
				return;
			}
			await route.fulfill({ json: serverWrites ? [{ ...savedServer, provider: provider.toLowerCase() }] : [] });
		});
		await page.route('**/api/v1/libraries', async (route) => {
			if (route.request().method() === 'POST') {
				libraryWrites += 1;
				expect(route.request().postDataJSON()).toMatchObject({ sourceType: provider.toLowerCase(), sourceConfig: { mediaServerId: savedServer.id, remoteLibraryId: 'films' } });
				await route.fulfill({ status: 201, json: library });
				return;
			}
			await route.fulfill({ json: [] });
		});
		await editor.getByRole('radio', { name: provider, exact: true }).click();
		await editor.getByLabel('Server address', { exact: true }).fill(savedServer.baseUrl);
		await editor.getByLabel('Username', { exact: true }).fill('admin');
		await editor.getByLabel(/^Password/).fill('synthetic-password');
		await editor.getByRole('button', { name: 'Show password', exact: true }).click();
		await expect(editor.getByLabel(/^Password/)).toHaveAttribute('type', 'text');
		await editor.getByRole('button', { name: 'Hide password', exact: true }).click();
		await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
		await expect(editor.getByRole('combobox', { name: 'Remote library', exact: true })).toHaveValue('films');
		await expect(editor.getByLabel(/^Password/)).toHaveValue('');
		expect(signIns).toBe(1);
		expect(serverWrites).toBe(0);
		expect(libraryWrites).toBe(0);
		const dialogNode = await editor.elementHandle();
		await editor.getByRole('button', { name: 'Add and Scan', exact: true }).click();
		await expect(page).toHaveURL(`/libraries/${libraryId}/settings`);
		const savedEditor = page.getByRole('dialog', { name: 'Library settings for My Movies', exact: true });
		await expect(savedEditor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
		expect(await dialogNode!.evaluate(node => node.isConnected)).toBe(true);
		await expect(savedEditor.getByRole('combobox', { name: 'Remote library', exact: true })).toHaveValue('films');
		expect(serverWrites).toBe(1);
		expect(libraryWrites).toBe(1);
		await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.includes(':library:')))).toEqual([]);
		await savedEditor.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(page).toHaveURL(`/libraries/${libraryId}`);
		await page.reload();
		await page.getByRole('link', { name: 'Libraries', exact: true }).click();
		await page.getByRole('button', { name: 'Add Library', exact: true }).first().click();
		const nextEditor = page.getByRole('dialog', { name: 'Add Library', exact: true });
		await expect(nextEditor.getByLabel('Name', { exact: true })).toHaveValue('');
		await expect(nextEditor.getByRole('status').filter({ hasText: 'Previous draft restored' })).toHaveCount(0);
	});
}

test('supports source and Advanced keyboard navigation, direct API keys, and empty discovery states', async ({ page }) => {
	const editor = await openLibrary(page);
	const folder = editor.getByRole('radio', { name: 'Folder', exact: true });
	await folder.focus();
	await folder.press('ArrowRight');
	await expect(editor.getByRole('radio', { name: 'Jellyfin', exact: true })).toBeFocused();
	await expect(editor.getByRole('radio', { name: 'Jellyfin', exact: true })).toHaveAttribute('aria-checked', 'true');
	await editor.getByRole('combobox', { name: 'Authentication method', exact: true }).selectOption('key');
	await editor.getByLabel('Server address', { exact: true }).fill(savedServer.baseUrl);
	await editor.getByLabel('API key', { exact: true }).fill('synthetic-key');
	await page.route('**/api/v1/media-servers/probe', (route) => route.fulfill({ json: { serverKey: 'test', serverName: 'Test', libraries: [] } }));
	await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
	await expect(editor.getByText('No matching libraries were found for this type.', { exact: true })).toBeVisible();
	await expect(editor.getByRole('button', { name: 'Add and Scan', exact: true })).toBeDisabled();
	await expect(editor.getByLabel('Scan every, minutes', { exact: true })).toBeHidden();
	const advanced = editor.getByRole('button', { name: 'Advanced', exact: true });
	await expect(advanced).toHaveAttribute('aria-expanded', 'false');
	await advanced.focus();
	await advanced.press('Enter');
	await expect(advanced).toHaveAttribute('aria-expanded', 'true');
	await expect(editor.getByLabel('Scan every, minutes', { exact: true })).toBeVisible();
	await advanced.press('Space');
	await expect(advanced).toHaveAttribute('aria-expanded', 'false');
	await expect(editor.getByLabel('Scan every, minutes', { exact: true })).toBeHidden();
	await expect(advanced).toBeFocused();
});

test('discards late discovery after a type change and invalidates tested TLS changes', async ({ page }) => {
	const editor = await openLibrary(page);
	await editor.getByRole('radio', { name: 'Jellyfin', exact: true }).click();
	await editor.getByRole('combobox', { name: 'Authentication method', exact: true }).selectOption('key');
	await editor.getByLabel('Server address', { exact: true }).fill(savedServer.baseUrl);
	await editor.getByLabel('API key', { exact: true }).fill('synthetic-key');
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve; 
	});
	let requests = 0;
	await page.route('**/api/v1/media-servers/probe', async (route) => {
		requests += 1;
		if (requests === 1) {
			await waiting;
		}
		await route.fulfill({ json: { serverKey: 'test', serverName: 'Test', libraries: movies } });
	});
	await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
	await expect(editor.getByText('Loading remote libraries…', { exact: true })).toBeVisible();
	await editor.getByRole('combobox', { name: 'Type', exact: true }).selectOption('shows');
	release();
	await expect(editor.getByRole('combobox', { name: 'Remote library', exact: true })).toHaveCount(0);
	await expect(editor.getByRole('button', { name: 'Add and Scan', exact: true })).toBeDisabled();
	await editor.getByRole('combobox', { name: 'Type', exact: true }).selectOption('movies');
	await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
	await expect(editor.getByRole('combobox', { name: 'Remote library', exact: true })).toHaveValue('films');
	await editor.getByRole('switch', { name: /Allow untrusted certificate/ }).check();
	await expect(editor.getByRole('button', { name: 'Add and Scan', exact: true })).toBeDisabled();
});

test('ignores late password tokens after changing the address', async ({ page }) => {
	const editor = await openLibrary(page);
	await editor.getByRole('radio', { name: 'Emby', exact: true }).click();
	await editor.getByLabel('Server address', { exact: true }).fill(savedServer.baseUrl);
	await editor.getByLabel('Username', { exact: true }).fill('admin');
	await editor.getByLabel(/^Password/).fill('synthetic-password');
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve; 
	});
	let probes = 0;
	let signIns = 0;
	await page.route('**/api/v1/media-servers/session', async (route) => {
		signIns += 1;
		const first = signIns === 1;
		if (first) {
			await waiting;
		}
		await route.fulfill({ json: { accessToken: first ? 'late-token' : 'fresh-token', clientIdentifier: 'test-client' } });
	});
	await page.route('**/api/v1/media-servers/probe', async (route) => {
		probes += 1;
		expect(route.request().postDataJSON()).toMatchObject({ baseUrl: 'https://other.example', accessToken: 'fresh-token' });
		await route.fulfill({ json: { serverKey: 'test', serverName: 'Test', libraries: movies } });
	});
	await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
	await editor.getByLabel('Server address', { exact: true }).fill('https://other.example');
	const lateResponse = page.waitForResponse('**/api/v1/media-servers/session');
	release();
	await lateResponse;
	await expect(editor.getByRole('button', { name: 'Add and Scan', exact: true })).toBeDisabled();
	await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
	await expect(editor.getByRole('combobox', { name: 'Remote library', exact: true })).toHaveValue('films');
	expect(signIns).toBe(2);
	expect(probes).toBe(1);
});

test('Plex link-code tokens can be tested without saving a connection', async ({ page }) => {
	const editor = await openLibrary(page);
	await editor.getByRole('radio', { name: 'Plex', exact: true }).click();
	await editor.getByLabel('Server address', { exact: true }).fill(savedServer.baseUrl);
	await page.route('**/api/v1/media-servers/plex/pin', (route) => route.fulfill({ json: { pinId: 9, code: 'TEST', clientIdentifier: 'test-client' } }));
	await page.route('**/api/v1/media-servers/plex/pin/9?*', (route) => route.fulfill({ json: { accessToken: 'synthetic-plex-token', clientIdentifier: 'test-client' } }));
	await page.route('**/api/v1/media-servers/probe', (route) => route.fulfill({ json: { serverKey: 'test', serverName: 'Plex', libraries: movies } }));
	await editor.getByRole('button', { name: 'Sign in with Plex', exact: true }).click();
	await expect(editor.getByRole('status')).toContainText('Signed in with Plex.');
	await expect(editor.getByLabel('Plex token', { exact: true })).toHaveCount(0);
	await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
	await expect(editor.getByRole('combobox', { name: 'Remote library', exact: true })).toHaveValue('films');
});

test('keeps an existing remote library editable while its server is offline', async ({ page }) => {
	await authenticateAdministrator(page);
	const id = '22222222-2222-4222-8222-222222222222';
	let library = {
		id, name: 'Offline films', typeKey: 'movies', sourceType: 'jellyfin',
		sourceConfig: { mediaServerId: savedServer.id, remoteLibraryId: 'films', remoteLibraryName: 'Films' },
		scanIntervalMinutes: 15, watcherEnabled: false, enabled: true, watcherStatus: 'stopped',
		sourceAvailability: 'unavailable', sourceAvailabilityUpdatedAt: null, reconciliationStatus: 'idle',
		pendingRemovalCount: 0, itemCount: 0, warningCount: 0,
		lastScanStartedAt: null, lastScanCompletedAt: null, lastChangeDetectedAt: null, lastIndexedChangeAt: null,
		createdAt: savedServer.createdAt, updatedAt: savedServer.updatedAt,
	};
	let patches = 0;
	await page.route('**/api/v1/media-servers', (route) => route.fulfill({ json: [savedServer] }));
	await page.route(`**/api/v1/media-servers/${savedServer.id}/probe`, (route) => route.fulfill({ status: 400, json: { message: 'Synthetic offline server', code: 'request_failed', requestId: 'test' } }));
	await page.route(`**/api/v1/libraries/${id}`, async (route) => {
		if (route.request().method() === 'PATCH') {
			patches += 1;
			library = { ...library, ...route.request().postDataJSON() };
		}
		await route.fulfill({ json: library });
	});
	await page.route(`**/api/v1/libraries/${id}/**`, async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		await route.fulfill({ json: pathname.endsWith('/reconciliation')
			? { libraryId: id, status: 'idle', pendingRemovalCount: 0, missingItems: [], sourceChangeCanBeCancelled: false }
			: pathname.endsWith('/media') ? { entries: [], groups: [], items: [], navigation: [], pagination: { page: 1, pageSize: 100, totalEntries: 0, totalPages: 0 } } : [] });
	});
	await page.goto(`/libraries/${id}/settings`);
	const editor = page.getByRole('dialog', { name: /^Library settings for/ });
	await expect(editor.getByRole('alert').filter({ hasText: 'Synthetic offline server' })).toBeVisible();
	await editor.getByLabel('Name', { exact: true }).fill('Renamed offline library');
	await editor.getByRole('button', { name: 'Advanced', exact: true }).click();
	await editor.getByRole('button', { name: 'Add folder mapping', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await editor.getByRole('button', { name: 'Remove mapping', exact: true }).click();
	await editor.getByRole('button', { name: 'Remove this mapping', exact: true }).click();
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	expect(patches).toBe(1);
	expect(library.sourceConfig.remoteLibraryId).toBe('films');
});

test('matches the revised library layout at desktop and phone sizes', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1350 });
	const editor = await openLibrary(page);
	await editor.getByRole('radio', { name: 'Jellyfin', exact: true }).click();
	await editor.getByLabel('Server name', { exact: true }).fill('Home Jellyfin');
	await editor.getByLabel('Server address', { exact: true }).fill('https://media.example:8096');
	await page.screenshot({ path: 'test-results/library-editor-desktop.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await editor.getByLabel('Username', { exact: true }).fill('admin');
	await expect(editor.getByRole('button', { name: 'Close library editor', exact: true })).toBeVisible();
	const save = editor.getByRole('button', { name: 'Add and Scan', exact: true });
	await expect(save).toBeVisible();
	const footer = await save.boundingBox();
	expect(footer!.y + footer!.height).toBeLessThanOrEqual(844);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.screenshot({ path: 'test-results/library-editor-phone.png' });
});

test('protects and saves a replacement server when both servers use the same remote library id', async ({ page }) => {
	await authenticateAdministrator(page);
	const id = '22222222-2222-4222-8222-222222222222';
	const first = { ...savedServer, provider: 'plex', name: 'First server' };
	const second = { ...first, id: '33333333-3333-4333-8333-333333333333', name: 'Second server', baseUrl: 'https://second.example', serverKey: 'second-server' };
	let library = {
		id, name: 'Films', typeKey: 'movies', sourceType: 'plex',
		sourceConfig: { mediaServerId: first.id, remoteLibraryId: '1', remoteLibraryName: 'Movies' },
		scanIntervalMinutes: 15, watcherEnabled: false, enabled: true, watcherStatus: 'stopped',
		sourceAvailability: 'available', sourceAvailabilityUpdatedAt: null, reconciliationStatus: 'idle',
		pendingRemovalCount: 0, itemCount: 0, warningCount: 0,
		lastScanStartedAt: null, lastScanCompletedAt: null, lastChangeDetectedAt: null, lastIndexedChangeAt: null,
		createdAt: savedServer.createdAt, updatedAt: savedServer.updatedAt,
	};
	let patches = 0;
	await page.route('**/api/v1/media-servers', (route) => route.fulfill({ json: [first, second] }));
	await page.route('**/api/v1/media-servers/*/probe', (route) => route.fulfill({ json: {
		serverKey: 'test-server', serverName: 'Plex', libraries: [{ id: '1', name: 'Movies', typeKey: 'movies' }],
	} }));
	await page.route(`**/api/v1/libraries/${id}`, async (route) => {
		if (route.request().method() === 'PATCH') {
			patches += 1;
			library = { ...library, ...route.request().postDataJSON() };
		}
		await route.fulfill({ json: library });
	});
	await page.route(`**/api/v1/libraries/${id}/**`, async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		await route.fulfill({ json: pathname.endsWith('/reconciliation')
			? { libraryId: id, status: 'idle', pendingRemovalCount: 0, missingItems: [], sourceChangeCanBeCancelled: false }
			: pathname.endsWith('/media') ? { entries: [], groups: [], items: [], navigation: [], pagination: { page: 1, pageSize: 100, totalEntries: 0, totalPages: 0 } } : [] });
	});
	await page.goto(`/libraries/${id}/settings`);
	const editor = page.getByRole('dialog', { name: 'Library settings for Films', exact: true });
	const selector = editor.getByRole('combobox', { name: 'Server', exact: true });
	const remote = editor.getByRole('combobox', { name: 'Remote library', exact: true });
	const save = editor.getByRole('button', { name: 'Save', exact: true });
	await expect(remote).toHaveValue('1');
	await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await selector.selectOption(second.id);
	await expect(remote).toHaveValue('1');
	await expect(save).toBeEnabled();
	await expect(editor.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled();
	await editor.getByRole('button', { name: 'Close library editor', exact: true }).click();
	const confirmation = page.getByRole('alertdialog', { name: 'Save Changes?', exact: true });
	await expect(confirmation).toBeVisible();
	await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
	await editor.getByRole('button', { name: 'Reset', exact: true }).click();
	await expect(selector).toHaveValue(second.id);
	await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(selector).toHaveValue(first.id);
	await expect(remote).toHaveValue('1');
	await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await selector.selectOption(second.id);
	await expect(remote).toHaveValue('1');
	await save.click();
	await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	expect(patches).toBe(1);
	expect(library.sourceConfig).toMatchObject({ mediaServerId: second.id, remoteLibraryId: '1' });
});


test('saves and closes a remote-source draft from the unsaved-changes prompt', async ({ page }) => {
	await authenticateAdministrator(page);
	const id = '22222222-2222-4222-8222-222222222222';
	const first = { ...savedServer, provider: 'plex', name: 'First server' };
	const second = { ...first, id: '33333333-3333-4333-8333-333333333333', name: 'Second server', baseUrl: 'https://second.example', serverKey: 'second-server' };
	let library = {
		id, name: 'Films', typeKey: 'movies', sourceType: 'plex',
		sourceConfig: { mediaServerId: first.id, remoteLibraryId: '1', remoteLibraryName: 'Movies' },
		scanIntervalMinutes: 15, watcherEnabled: false, enabled: true, watcherStatus: 'stopped',
		sourceAvailability: 'available', sourceAvailabilityUpdatedAt: null, reconciliationStatus: 'idle',
		pendingRemovalCount: 0, itemCount: 0, warningCount: 0,
		lastScanStartedAt: null, lastScanCompletedAt: null, lastChangeDetectedAt: null, lastIndexedChangeAt: null,
		createdAt: savedServer.createdAt, updatedAt: savedServer.updatedAt,
	};
	let patches = 0;
	await page.route('**/api/v1/media-servers', (route) => route.fulfill({ json: [first, second] }));
	await page.route('**/api/v1/media-servers/*/probe', (route) => route.fulfill({ json: {
		serverKey: 'test-server', serverName: 'Plex', libraries: [{ id: '1', name: 'Movies', typeKey: 'movies' }],
	} }));
	await page.route(`**/api/v1/libraries/${id}`, async (route) => {
		if (route.request().method() === 'PATCH') {
			patches += 1;
			library = { ...library, ...route.request().postDataJSON() };
		}
		await route.fulfill({ json: library });
	});
	await page.route(`**/api/v1/libraries/${id}/**`, async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		await route.fulfill({ json: pathname.endsWith('/reconciliation')
			? { libraryId: id, status: 'idle', pendingRemovalCount: 0, missingItems: [], sourceChangeCanBeCancelled: false }
			: pathname.endsWith('/media') ? { entries: [], groups: [], items: [], navigation: [], pagination: { page: 1, pageSize: 100, totalEntries: 0, totalPages: 0 } } : [] });
	});
	await page.goto(`/libraries/${id}/settings`);
	const editor = page.getByRole('dialog', { name: 'Library settings for Films', exact: true });
	const selector = editor.getByRole('combobox', { name: 'Server', exact: true });
	const remote = editor.getByRole('combobox', { name: 'Remote library', exact: true });
	const save = editor.getByRole('button', { name: 'Save', exact: true });
	await expect(remote).toHaveValue('1');
	await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await selector.selectOption(second.id);
	await expect(remote).toHaveValue('1');
	await expect(save).toBeEnabled();
	await expect(editor.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled();
	await editor.getByRole('button', { name: 'Close library editor', exact: true }).click();
	const confirmation = page.getByRole('alertdialog', { name: 'Save Changes?', exact: true });
	await expect(confirmation).toBeVisible();
	await confirmation.getByRole('button', { name: 'Save Settings', exact: true }).click();
	await expect(editor).toBeHidden();
	await expect(page).toHaveURL(new RegExp(`/libraries/${id}$`));
	expect(patches).toBe(1);
	expect(library.sourceConfig).toMatchObject({ mediaServerId: second.id, remoteLibraryId: '1' });
});
