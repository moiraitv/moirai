import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('keeps log rows compact and opens structured details on demand', async ({ page }) => {
	await authenticateAdministrator(page);
	const firstEntry = {
		id: 'log-entry-one',
		time: '2026-08-25T15:24:31.000Z',
		level: 'info',
		message: 'incoming request',
		requestId: 'req-compact-1',
		context: {
			req: {
				method: 'GET',
				url: '/api/v1/libraries/library-one/media?cursor=private-value',
				remoteAddress: '192.0.2.25',
			},
			libraryId: 'library-one',
			counts: { added: 12, removed: 0 },
		},
	};

	const completedEntry = {
		id: 'log-entry-one-completed',
		time: '2026-08-25T15:24:31.043Z',
		level: 'info',
		message: 'request completed',
		requestId: 'req-compact-1',
		context: {
			res: { statusCode: 200 },
			responseTime: 42.75,
		},
	};

	const entries = [
		completedEntry,
		firstEntry,
		{
			id: 'log-entry-two',
			time: '2026-08-25T15:25:02.000Z',
			level: 'warn',
			message: 'Source response was slower than expected and this deliberately long message must remain on one line',
			requestId: null,
			context: {},
		},
	];

	await page.route(/\/api\/v1\/logs\?.*$/, async (route) => {
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({
				entries,
				nextCursor: null,
				scannedBytes: 2_048,
				scanLimitReached: false,
			}),
		});
	});

	await page.route('**/api/v1/logs/files', async (route) => {
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify([
				{
					name: 'moirai-2026-08-25.jsonl',
					size: 2_048,
					modifiedAt: '2026-08-25T15:25:02.000Z',
					active: true,
				},
			]),
		});
	});

	await page.setViewportSize({ width: 1600, height: 900 });
	await page.goto('/logs');

	const searchInput = page.getByPlaceholder('Search messages and context…');
	const searchIcon = page.locator('.logs-search svg');
	const searchInputBox = await searchInput.boundingBox();
	const searchIconBox = await searchIcon.boundingBox();
	expect(
		Math.abs(
			(searchInputBox?.y ?? 0)
			+ (searchInputBox?.height ?? 0) / 2
			- ((searchIconBox?.y ?? 0) + (searchIconBox?.height ?? 0) / 2),
		),
	).toBeLessThan(2);

	const rows = page.locator('.log-entry');
	await expect(rows).toHaveCount(2);
	await expect(rows.first().locator('.log-entry-request')).toBeVisible();
	await expect(rows.first().locator('.log-entry-endpoint')).toContainText('GET');
	await expect(rows.first().locator('.log-entry-endpoint')).toContainText(
		'/api/v1/libraries/library-one/media',
	);
	await expect(rows.first().locator('.log-entry-endpoint')).not.toContainText('private-value');
	await expect(rows.first().locator('.log-entry-source')).toHaveText('192.0.2.25');
	await expect(rows.first().locator('.log-entry-result')).toContainText('200');
	await expect(rows.first().locator('.log-entry-result')).toContainText('42.8 ms');
	const statusBox = await rows.first().locator('.log-entry-result small').boundingBox();
	const durationBox = await rows.first().locator('.log-entry-result span').boundingBox();
	expect((statusBox?.x ?? 0) + (statusBox?.width ?? 0)).toBeLessThanOrEqual(
		(durationBox?.x ?? 0) + 1,
	);
	const rowBox = await rows.first().boundingBox();
	expect(rowBox?.height).toBeLessThanOrEqual(48);
	await expect(page.locator('.logs-list pre')).toHaveCount(0);

	await rows.first().click();

	const dialog = page.getByRole('dialog', { name: 'Log entry details' });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(firstEntry.message);
	await expect(dialog).toContainText('library-one');
	await expect(dialog).toContainText('/api/v1/libraries/library-one/media');
	await expect(dialog).toContainText('192.0.2.25');
	await expect(dialog).toContainText('42.75 ms');
	await expect(dialog.getByRole('button', { name: 'Copy context' })).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Copy complete entry' })).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(rows.first()).toBeFocused();

	const retainedFiles = page.locator('details.log-files');
	await expect(retainedFiles).not.toHaveAttribute('open', '');
	await expect(page.getByRole('link', { name: /moirai-2026-08-25\.jsonl/ })).toBeHidden();
	await retainedFiles.locator('summary').click();
	await expect(retainedFiles).toHaveAttribute('open', '');
	await expect(page.getByRole('link', { name: /moirai-2026-08-25\.jsonl/ })).toBeVisible();

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(rows.first().locator('.log-entry-request')).toBeHidden();
	await expect(rows.first().locator('.log-entry-time-compact')).toBeVisible();
	const mobileRowBox = await rows.first().boundingBox();
	expect(mobileRowBox?.height).toBeLessThanOrEqual(48);
});
