import { expect } from '@playwright/test';
import { test } from './documentation/fixture';
import { authenticateAdministrator } from './authentication';
import { seedSchedule } from './documentation/seed';

test('keeps copy failures visible and offers a dismissible success notification', async ({ page, context }) => {
	await authenticateAdministrator(page);
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
			writeText: async () => {
				throw new Error('Unavailable clipboard'); 
			},
		} });
	});
	await page.goto('/guide');
	const copy = page.getByRole('button', { name: 'Copy URL', exact: true }).first();
	await expect(copy).toBeEnabled();
	await copy.click();
	const failure = page.getByRole('alert').filter({ hasText: /Unable to copy playlist URL/i });
	await expect(failure).toBeVisible();
	await page.clock.install();
	await page.clock.fastForward(10_000);
	await expect(failure).toBeVisible();
	await page.evaluate(() => {
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
	});
	await copy.click();
	await expect(failure).toHaveCount(0);
	await expect(page.locator('.transient-toast')).toContainText('Playlist URL copied');
	await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
	await page.clock.fastForward(400);
	await expect(page.locator('.transient-toast')).toHaveCount(0);
});

test('retries music-video credit template loading without changing the channel draft', async ({ page }) => {
	await authenticateAdministrator(page);
	let failing = true;
	await page.route('**/api/v1/credit-templates', route => failing
		? route.fulfill({ status: 503, json: { message: 'Credits unavailable' } })
		: route.continue());
	await page.goto('/channels/new');
	const dialog = page.getByRole('dialog', { name: 'Create Channel', exact: true });
	await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Retained credit draft');
	await dialog.getByRole('button', { name: /Video & audio settings/ }).click();
	await dialog.getByRole('switch', { name: 'Music video credits', exact: true }).click();
	await expect(dialog.getByText('Credits unavailable', { exact: false })).toBeVisible();
	const template = dialog.getByRole('combobox', { name: 'Credit template', exact: true });
	await expect(template).toBeDisabled();
	failing = false;
	await dialog.locator('.subtitle-credits-option').getByRole('button', { name: 'Retry', exact: true }).click();
	await expect(template).toBeEnabled();
	await expect(dialog.getByText('Credits unavailable', { exact: false })).toHaveCount(0);
	await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Retained credit draft');
});

test('retries contextual help while retaining its owning editor', async ({ page }) => {
	await authenticateAdministrator(page);
	let failing = true;
	await page.route('**/help/contextual-help.json', route => failing
		? route.fulfill({ status: 503 })
		: route.fulfill({ json: { version: 1, guideVersion: 'test', topics: {
			'channels.manage': { id: 'channels.manage', title: 'Channels', description: 'Channel guidance', html: '<p>Recovered guidance</p>', fullPath: '/help/scheduling/channels.html', reviewStatus: 'needs-review' },
		} } }));
	await page.goto('/channels/new');
	const dialog = page.getByRole('dialog', { name: 'Create Channel', exact: true });
	await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Help draft');
	await dialog.getByRole('button', { name: 'Help with Channels', exact: true }).click();
	const help = page.locator('.help-drawer');
	await expect(help).toContainText('Help is unavailable');
	failing = false;
	await help.getByRole('button', { name: 'Retry', exact: true }).click();
	await expect(help).toContainText('Recovered guidance');
	await help.getByRole('button', { name: 'Close help', exact: true }).click();
	await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Help draft');
});

test('returns media details to their library instead of an unrelated previous page', async ({ page, documentationServer }) => {
	const { libraryId } = await seedSchedule(page, documentationServer.directory);
	const media = await (await page.request.get(`/api/v1/libraries/${libraryId}/media`)).json();
	const id = media.items[0].id;
	await page.goto('/settings');
	await page.goto(`/libraries/${libraryId}/items/${id}`);
	await page.getByRole('button', { name: /Back/ }).click();
	await expect(page).toHaveURL(`/libraries/${libraryId}`);
});
