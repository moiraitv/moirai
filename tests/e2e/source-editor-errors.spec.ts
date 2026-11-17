import { expect, test, type Locator } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

/** Verify an error stays between the heading and footer at both scroll extremes. */
async function expectPinnedError(editor: Locator, message: string): Promise<void> {
	const alert = editor.getByRole('alert').filter({ hasText: message });
	await expect(alert).toHaveCount(1);
	for (const bottom of [false, true]) {
		await editor.locator('.resource-editor-scroll').evaluate((element, atBottom) => {
			element.scrollTop = atBottom ? element.scrollHeight : 0;
		}, bottom);
		await expect(alert).toBeInViewport({ ratio: 1 });
		const heading = await editor.getByRole('heading', { level: 2 }).boundingBox();
		const bounds = await alert.boundingBox();
		expect(bounds!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height);
		await expect(editor.getByRole('button', { name: /^(Save|Add and Scan)$/ })).toBeInViewport();
	}
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
	test(`keeps server sign-in, connection, and save errors visible at ${viewport.width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize(viewport);
		await authenticateAdministrator(page);
		await page.route('**/api/v1/media-servers', route => route.fulfill(route.request().method() === 'POST'
			? { status: 409, json: { message: 'That server name is already in use', code: 'conflict', requestId: 'test' } }
			: { json: [] }));
		await page.route('**/api/v1/media-servers/plex/pin', route => route.fulfill({ status: 400, json: { message: 'Sign-in unavailable', code: 'request_failed', requestId: 'test' } }));
		let probeFailed = true;
		await page.route('**/api/v1/media-servers/probe', route => route.fulfill(probeFailed
			? { status: 400, json: { message: 'Cannot connect to server', code: 'request_failed', requestId: 'test' } }
			: { json: { serverKey: 'test', serverName: 'Test Plex', libraries: [] } }));
		await page.goto('/settings/media-servers');
		await page.getByRole('button', { name: 'Add Media Server', exact: true }).click();
		const editor = page.getByRole('dialog', { name: 'Add Media Server', exact: true });
		await editor.getByRole('radio', { name: 'Plex', exact: true }).click();
		await editor.getByLabel('Server name', { exact: true }).fill('Home Plex');
		await editor.getByLabel('Server address', { exact: true }).fill('https://plex.example');
		await editor.getByRole('button', { name: 'Sign in with Plex', exact: true }).click();
		await expectPinnedError(editor, 'Sign-in unavailable');
		await editor.getByRole('combobox', { name: 'Authentication method', exact: true }).selectOption('key');
		await expect(editor.getByRole('alert')).toHaveCount(0);
		await editor.getByLabel('Plex token', { exact: true }).fill('synthetic-test-token');
		await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
		await expectPinnedError(editor, 'Cannot connect to server');
		probeFailed = false;
		await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
		await expect(editor.getByRole('alert')).toHaveCount(0);
		await editor.getByRole('button', { name: 'Save', exact: true }).click();
		await expectPinnedError(editor, 'That server name is already in use');
		await page.screenshot({ path: testInfo.outputPath('server-error.png') });
		await editor.getByRole('button', { name: 'Reset', exact: true }).click();
		await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
		await expect(editor.getByRole('alert')).toHaveCount(0);
	});

	test(`keeps library connection and duplicate-server errors visible at ${viewport.width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize(viewport);
		await authenticateAdministrator(page);
		await page.route('**/api/v1/media-servers', route => route.fulfill(route.request().method() === 'POST'
			? { status: 409, json: { message: 'That server name is already in use', code: 'conflict', requestId: 'test' } }
			: { json: [] }));
		let probeFailed = true;
		await page.route('**/api/v1/media-servers/probe', route => route.fulfill(probeFailed
			? { status: 400, json: { message: 'Cannot connect to library server', code: 'request_failed', requestId: 'test' } }
			: { json: { serverKey: 'test', serverName: 'Test Jellyfin', libraries: [{ id: 'films', name: 'Films', typeKey: 'movies' }] } }));
		await page.goto('/libraries/new');
		const editor = page.getByRole('dialog', { name: 'Add Library', exact: true });
		await editor.getByLabel('Name', { exact: true }).fill('Films');
		await editor.getByRole('radio', { name: 'Jellyfin', exact: true }).click();
		await editor.getByLabel('Server name', { exact: true }).fill('Home Jellyfin');
		await editor.getByLabel('Server address', { exact: true }).fill('https://jellyfin.example');
		await editor.getByRole('combobox', { name: 'Authentication method', exact: true }).selectOption('key');
		await editor.getByLabel('API key', { exact: true }).fill('synthetic-test-key');
		await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
		await expectPinnedError(editor, 'Cannot connect to library server');
		probeFailed = false;
		await editor.getByRole('button', { name: 'Test connection', exact: true }).click();
		await expect(editor.getByRole('combobox', { name: 'Remote library', exact: true })).toHaveValue('films');
		await expect(editor.getByRole('alert')).toHaveCount(0);
		await editor.getByRole('button', { name: 'Add and Scan', exact: true }).click();
		await expectPinnedError(editor, 'That server name is already in use');
		await page.screenshot({ path: testInfo.outputPath('library-error.png') });
		await editor.getByRole('button', { name: 'Reset', exact: true }).click();
		await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
		await expect(editor.getByRole('alert')).toHaveCount(0);
	});
}


test('keeps saved-library save and delete failures visible on a phone', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await authenticateAdministrator(page);
	const id = '22222222-2222-4222-8222-222222222222';
	const library = {
		id, name: 'Films', typeKey: 'movies', sourceType: 'on-disk',
		sourceConfig: { scanRoot: '/media/films', playbackRoot: null },
		scanIntervalMinutes: 15, watcherEnabled: false, enabled: true, watcherStatus: 'stopped',
		sourceAvailability: 'available', sourceAvailabilityUpdatedAt: null, reconciliationStatus: 'idle',
		pendingRemovalCount: 0, itemCount: 0, warningCount: 0,
		lastScanStartedAt: null, lastScanCompletedAt: null, lastChangeDetectedAt: null, lastIndexedChangeAt: null,
		createdAt: '2026-01-15T00:00:00.000Z', updatedAt: '2026-01-15T00:00:00.000Z',
	};
	await page.route('**/api/v1/media-servers', route => route.fulfill({ json: [] }));
	await page.route(`**/api/v1/libraries/${id}`, route => route.fulfill(route.request().method() === 'GET'
		? { json: library }
		: { status: 409, json: { message: 'Library change rejected', code: 'conflict', requestId: 'test' } }));
	await page.route(`**/api/v1/libraries/${id}/**`, async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		await route.fulfill({ json: pathname.endsWith('/reconciliation')
			? { libraryId: id, status: 'idle', pendingRemovalCount: 0, missingItems: [], sourceChangeCanBeCancelled: false }
			: pathname.endsWith('/media') ? { entries: [], groups: [], items: [], navigation: [], pagination: { page: 1, pageSize: 100, totalEntries: 0, totalPages: 0 } } : [] });
	});
	await page.goto(`/libraries/${id}/settings`);
	const editor = page.getByRole('dialog', { name: 'Library settings for Films', exact: true });
	await editor.getByLabel('Name', { exact: true }).fill('Renamed films');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expectPinnedError(editor, 'Library change rejected');
	await editor.getByRole('button', { name: 'Delete Library', exact: true }).click();
	const confirmation = page.getByRole('alertdialog', { name: 'Delete Library?', exact: true });
	await confirmation.getByRole('textbox').fill('Films');
	const deleted = page.waitForResponse(response => response.url().endsWith(`/api/v1/libraries/${id}`) && response.request().method() === 'DELETE');
	await confirmation.getByRole('button', { name: 'Delete Library', exact: true }).click();
	await deleted;
	await expect(confirmation).toBeHidden();
	await expectPinnedError(editor, 'Library change rejected');
	await editor.getByRole('button', { name: 'Reset', exact: true }).click();
	await editor.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(editor.getByRole('alert')).toHaveCount(0);
});
