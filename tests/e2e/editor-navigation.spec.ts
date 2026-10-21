import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './documentation/fixture';
import { authenticateAdministrator } from './authentication';
import { seedSchedule } from './documentation/seed';

for (const collection of ['encoding-profiles', 'credit-templates', 'guide-templates', 'pre-rolls', 'mid-rolls', 'post-rolls', 'tail-fillers']) {
	test(`restores ${collection} viewing, duplication, and retained history drafts`, async ({ page }) => {
		await authenticateAdministrator(page);
		const base = `${collection.endsWith('templates') || collection === 'encoding-profiles' ? '/playback' : '/filler'}/${collection}`;
		await page.goto(base);
		await page.getByRole('button', { name: 'View', exact: true }).first().click();
		await expect(page).toHaveURL(new RegExp(`${base}/[^/?]+$`));
		const originalUrl = page.url();
		const dialog = page.getByRole('dialog').last();
		const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
		await expect(name).toBeDisabled();
		await page.reload();
		await expect(name).toBeDisabled();
		await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`${base}/new\\?duplicate=`));
		await expect(name).toBeEnabled();
		const originalName = await name.inputValue();
		await page.reload();
		await expect(name).toHaveValue(originalName);
		await name.fill('Unsaved navigation draft');
		await page.goBack();
		await expect(page).toHaveURL(originalUrl);
		await expect(name).toBeDisabled();
		await page.goForward();
		await expect(name).toHaveValue('Unsaved navigation draft');
		await page.reload();
		await expect(name).toHaveValue('Unsaved navigation draft');
		await expect(page.getByRole('alertdialog')).toHaveCount(0);
		await dialog.locator('.resource-editor-close').click();
		await expect(page).toHaveURL(base);
		await expect(dialog).toHaveCount(0);
	});
}

test('uses channel paths, preserves dirty drafts, and accepts old bookmarks', async ({ page, documentationServer }) => {
	const seeded = await seedSchedule(page, documentationServer.directory);
	const channels = await (await page.request.get('/api/v1/channels')).json() as Array<{ id: string; name: string }>;
	const channel = channels.find(candidate => candidate.id === seeded.channel.id)!;
	await page.goto('/channels');
	await page.getByRole('button', { name: `Edit ${channel.name}`, exact: true }).click();
	await expect(page).toHaveURL(`/channels/${channel.id}`);
	await page.reload();
	const dialog = page.getByRole('dialog', { name: 'Edit Channel', exact: true });
	const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
	await expect(name).toHaveValue(channel.name);
	await name.fill('Retained channel draft');
	await page.goBack();
	await expect(page).toHaveURL('/channels');
	await page.goForward();
	await expect(name).toHaveValue('Retained channel draft');
	await dialog.getByRole('button', { name: 'Close channel editor' }).click();
	await page.goto(`/channels?edit=${channel.id}`);
	await expect(page).toHaveURL(`/channels/${channel.id}`);
	await expect(name).toHaveValue('Retained channel draft');
	await page.goto('/channels?new=1');
	await expect(page).toHaveURL('/channels/new');
	await expect(page.getByRole('dialog', { name: 'Create Channel', exact: true })).toBeVisible();
});

test('preserves a pending library type and path through subsequent saves and reset', async ({ page, documentationServer }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const originalRoot = path.join(documentationServer.directory, 'original-source');
	const replacementRoot = path.join(documentationServer.directory, 'replacement-source');
	await mkdir(originalRoot, { recursive: true });
	await mkdir(replacementRoot, { recursive: true });
	const created = await page.request.post('/api/v1/libraries', { headers, data: {
		name: 'Pending source settings', typeKey: 'movies', sourceType: 'on-disk',
		sourceConfig: { scanRoot: originalRoot, playbackRoot: null },
		watcherEnabled: false, enabled: false,
	} });
	expect(created.ok(), await created.text()).toBe(true);
	const library = await created.json();
	await page.goto(`/libraries/${library.id}/settings`);
	const dialog = page.getByRole('dialog').last();
	await expect(dialog).toBeVisible();
	const type = dialog.getByRole('combobox', { name: /^Type/ });
	const scanRoot = dialog.getByLabel('Path Moirai scans', { exact: true });
	const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
	const save = dialog.getByRole('button', { name: 'Save', exact: true });
	await type.selectOption('other');
	await scanRoot.fill(replacementRoot);
	const firstSave = page.waitForResponse(response => response.url().endsWith(`/api/v1/libraries/${library.id}`)
		&& response.request().method() === 'PATCH');
	await save.click();
	const staged = await (await firstSave).json();
	expect(staged.typeKey).toBe('movies');
	expect(staged.sourceConfig.scanRoot).toBe(originalRoot);
	await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await expect(type).toHaveValue('other');
	await expect(scanRoot).toHaveValue(replacementRoot);

	await name.fill('Renamed pending source');
	const secondSave = page.waitForResponse(response => response.url().endsWith(`/api/v1/libraries/${library.id}`)
		&& response.request().method() === 'PATCH');
	await save.click();
	const saved = await secondSave;
	expect(saved.ok(), await saved.text()).toBe(true);
	expect(saved.request().postDataJSON()).toMatchObject({
		name: 'Renamed pending source', typeKey: 'other',
		sourceConfig: { scanRoot: replacementRoot, playbackRoot: null },
	});
	await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
	await scanRoot.fill(originalRoot);
	await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
	await dialog.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
	await expect(scanRoot).toHaveValue(replacementRoot);
	await expect(type).toHaveValue('other');
	await expect(name).toHaveValue('Renamed pending source');
	await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
});

test('restores library settings and retains changes between library routes', async ({ page, documentationServer }) => {
	const { libraryId } = await seedSchedule(page, documentationServer.directory);
	await page.goto(`/libraries/${libraryId}?q=moon`);
	await page.getByRole('button', { name: 'Library settings', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/libraries/${libraryId}/settings\\?q=moon(?:&anchor=[^&]+)?$`));
	await page.reload();
	const dialog = page.getByRole('dialog').last();
	await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Unsaved library settings');
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`/libraries/${libraryId}\\?q=moon(?:&anchor=[^&]+)?$`));
	await expect(dialog).toHaveCount(0);
	await page.goForward();
	await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Unsaved library settings');
	await page.goto('/libraries/new');
	await page.reload();
	await expect(page.getByRole('dialog', { name: 'Add Library', exact: true })).toBeVisible();
});

for (const base of ['/channels', '/playback/encoding-profiles', '/filler/mid-rolls']) {
	test(`distinguishes failed reads from missing resources at ${base}`, async ({ page }) => {
		await authenticateAdministrator(page);
		const endpoint = base === '/channels' ? 'channels' : base.includes('playback') ? 'encoding-profiles' : 'filler-presets';
		let failing = true;
		await page.route(`**/api/v1/${endpoint}*`, route => failing
			? route.fulfill({ status: 503, json: { message: 'Catalog unavailable' } })
			: route.continue());
		await page.goto(`${base}/${randomUUID()}`);
		await expect(page.locator('p.notice.error').filter({ hasText: 'Catalog unavailable' }).first()).toBeVisible();
		await expect(page.getByText(/not found/)).toHaveCount(0);
		failing = false;
		await page.getByRole('button', { name: 'Retry', exact: true }).first().click();
		await expect(page.getByText(/not found. It may have been deleted/)).toBeVisible();
	});
}

for (const base of ['/guide', '/channels']) {
	test(`keeps the latest guide date when Forward overtakes a pending Back read at ${base}`, async ({ page, documentationServer }) => {
		await seedSchedule(page, documentationServer.directory);
		await page.goto(`${base}?startDate=2026-01-16`);
		await expect(page.locator('.guide-week-controls strong')).toContainText('Jan 16');
		await page.getByRole('button', { name: 'Today', exact: true }).click();
		await expect(page).toHaveURL(base);
		await expect(page.locator('.guide-week-controls strong')).toContainText('Jan 15');

		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		let held = 0;
		let currentReads = 0;
		await page.route('**/api/v1/schedule-guide?*', async route => {
			if (new URL(route.request().url()).searchParams.get('startDate') === '2026-01-16') {
				held += 1;
				await gate;
			}
			else {
				currentReads += 1;
			}
			await route.continue();
		});
		try {
			await page.goBack();
			await expect.poll(() => held).toBeGreaterThan(0);
			await page.goForward();
			await expect(page).toHaveURL(base);
			await expect.poll(() => currentReads).toBeGreaterThan(0);
			release();
			await page.unrouteAll({ behavior: 'wait' });
			await expect(page.locator('.guide-week-controls strong')).toContainText('Jan 15');
			await expect(page).toHaveURL(base);
		}
		finally {
			release();
			await page.unrouteAll({ behavior: 'wait' });
		}
	});

	test(`restores committed guide dates through browser history at ${base}`, async ({ page, documentationServer }) => {
		await seedSchedule(page, documentationServer.directory);
		await page.goto(`${base}?startDate=2026-01-16`);
		await expect(page.locator('.guide-week-controls strong')).toContainText('Jan 16');
		await page.reload();
		await expect(page.locator('.guide-week-controls strong')).toContainText('Jan 16');
		await page.getByRole('button', { name: 'Today', exact: true }).click();
		await expect(page).toHaveURL(base);
		await page.goBack();
		await expect(page.locator('.guide-week-controls strong')).toContainText('Jan 16');
		await page.goForward();
		await expect(page.locator('.guide-week-controls strong')).toContainText('Jan 15');
		await page.goto(`${base}?startDate=2026-02-31`);
		await expect(page).toHaveURL(base);
	});
}

test('restores Logs filters and avoids an empty-state claim after a failed first load', async ({ page }) => {
	await authenticateAdministrator(page);
	let failing = true;
	await page.route('**/api/v1/logs?*', route => failing
		? route.fulfill({ status: 503, json: { message: 'Logs unavailable' } })
		: route.fulfill({ json: { entries: [], nextCursor: null, scannedBytes: 0, scanLimitReached: false } }));
	await page.goto('/logs?level=warn&q=example');
	await expect(page.locator('p.notice.error').filter({ hasText: 'Logs unavailable' }).first()).toBeVisible();
	await expect(page.getByRole('heading', { name: 'No matching log entries' })).toHaveCount(0);
	failing = false;
	await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'No matching log entries' })).toBeVisible();
	await expect(page.getByLabel('Log level')).toHaveValue('warn');
	await expect(page.getByPlaceholder('Search messages and context…')).toHaveValue('example');
	await page.getByLabel('Log level').selectOption('error');
	await expect(page).toHaveURL(/level=error/);
	await page.goBack();
	await expect(page.getByLabel('Log level')).toHaveValue('warn');
	await page.reload();
	await expect(page.getByPlaceholder('Search messages and context…')).toHaveValue('example');
});
