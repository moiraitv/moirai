import { expect, test, type Page } from '@playwright/test';
import { authenticateAdministrator } from './authentication';

test('saves backup policy, creates and downloads a manual ZIP, restores it, and deletes it with confirmation', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/settings');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	const panel = page.getByRole('tabpanel', { name: /^Backups/ });
	await expect(panel.getByText('No saved backups yet.')).toBeVisible();
	await expect(panel.getByLabel('Enable automatic backups')).toBeChecked();
	await panel.getByRole('button', { name: 'Automatic Backup', exact: true }).click();
	await expect(panel.getByLabel('Backup interval (days)')).toHaveValue('1');
	await expect(panel.getByLabel('Automatic backups to retain')).toHaveValue('7');
	await panel.getByLabel('Automatic backups to retain').fill('2');
	await panel.getByRole('button', { name: 'Save Backup Settings' }).click();
	await expect(panel.getByRole('button', { name: 'Save Backup Settings' })).toBeDisabled();
	await panel.getByRole('button', { name: 'Create Backup', exact: true }).click();
	const row = panel.getByRole('row').filter({ hasText: 'Manual' }).first();
	await expect(row).toBeVisible();
	const download = page.waitForEvent('download');
	await row.getByRole('link', { name: 'Download' }).click();
	const downloaded = await download;
	expect(downloaded.suggestedFilename()).toMatch(/^moirai-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9-]{36}\.zip$/);
	expect(downloaded.suggestedFilename()).toBe(await row.locator('.backup-name span').innerText());
	await panel.getByLabel('Automatic backups to retain').fill('5');
	await panel.getByRole('button', { name: 'Save Backup Settings' }).click();
	await expect(panel.getByRole('button', { name: 'Save Backup Settings' })).toBeDisabled();
	await panel.getByLabel('Backup interval (days)').fill('3');
	await panel.getByLabel('Choose backup ZIP').setInputFiles((await downloaded.path())!);
	await expect(page.getByRole('alertdialog', { name: 'Replace Configuration?' })).toBeVisible();
	await page.getByRole('alertdialog', { name: 'Replace Configuration?' }).getByRole('button', { name: 'Restore and Restart' }).click();
	await page.getByRole('alertdialog', { name: 'Discard Unsaved Settings?' }).getByRole('button', { name: 'Continue', exact: true }).click();
	await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
	await authenticateAdministrator(page);
	await page.goto('/settings');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	await panel.getByRole('button', { name: 'Automatic Backup', exact: true }).click();
	await expect(panel.getByLabel('Automatic backups to retain')).toHaveValue('2');
	await expect(panel.getByText('Pre-restore recovery', { exact: true })).toBeVisible();
	await expect(panel.getByText('Manual', { exact: true })).toBeVisible();
	const manualRow = panel.getByRole('row').filter({ hasText: 'Manual' }).first();
	await manualRow.getByRole('button', { name: /^Delete backup / }).click();
	const deletion = page.getByRole('alertdialog', { name: 'Delete Backup?' });
	await expect(deletion).toContainText(await manualRow.locator('.backup-name span').innerText());
	await page.keyboard.press('Escape');
	await expect(deletion).toBeHidden();
	await expect(manualRow).toBeVisible();
	await manualRow.getByRole('button', { name: /^Delete backup / }).click();
	await deletion.getByRole('button', { name: 'Keep Backup' }).click();
	await expect(manualRow).toBeVisible();
	await manualRow.getByRole('button', { name: /^Delete backup / }).click();
	await deletion.getByRole('button', { name: 'Delete Backup', exact: true }).click();
	await expect(panel.getByText('Manual', { exact: true })).toBeHidden();
	await expect(panel.getByText('Pre-restore recovery', { exact: true })).toBeVisible();
});

test('distinguishes loading and errors from an empty collection and protects backup drafts', async ({ page }) => {
	await authenticateAdministrator(page);
	let fail = true;
	await page.route('**/api/v1/backups', async route => {
		if (route.request().method() === 'GET' && fail) {
			await route.fulfill({ status: 503, json: { message: 'Backup volume unavailable' } });
			return;
		}
		await route.continue();
	});
	await page.goto('/settings');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	const panel = page.getByRole('tabpanel', { name: /^Backups/ });
	await expect(panel.getByRole('alert')).toContainText('Backup volume unavailable');
	await expect(panel.getByText('No saved backups yet.')).toBeHidden();
	fail = false;
	await panel.getByRole('button', { name: 'Retry Backups' }).click();
	await panel.getByRole('button', { name: 'Automatic Backup', exact: true }).click();
	await panel.getByLabel('Backup interval (days)').fill('3');
	await page.getByRole('link', { name: 'Quick Setup' }).click();
	await expect(page.getByRole('alertdialog', { name: 'Discard Unsaved Changes?' })).toBeVisible();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Keep Editing' }).click();
	await panel.getByRole('button', { name: 'Reset Backup settings draft', exact: true }).click();
	await panel.getByRole('button', { name: 'Confirm Reset Backup settings draft', exact: true }).click();
	await expect(panel.getByLabel('Backup interval (days)')).toHaveValue('1');
});


test('protects backup writes, rejects malformed archives, and exposes operation conflicts', async ({ page }) => {
	expect((await page.request.get('/api/v1/backups')).status()).toBe(401);
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	expect((await page.request.post('/api/v1/backups')).status()).toBe(403);
	expect((await page.request.delete('/api/v1/backups/warning')).status()).toBe(403);
	expect((await page.request.delete('/api/v1/backups/warning', { headers })).status()).toBe(204);
	expect((await page.request.put('/api/v1/backups/settings', { headers, data: { enabled: true, intervalDays: 0, retention: 7 } })).status()).toBe(400);
	const invalid = await page.request.post('/api/v1/backups/import', { headers, multipart: { file: { name: 'invalid.zip', mimeType: 'application/zip', buffer: Buffer.from('invalid ZIP') } } });
	expect(invalid.status()).toBe(422);
	expect(await invalid.json()).toMatchObject({ code: 'backup_invalid_archive', requestId: expect.any(String) });
	const attempts = await Promise.all([page.request.post('/api/v1/backups', { headers }), page.request.post('/api/v1/backups', { headers })]);
	expect(attempts.map(response => response.status()).sort()).toEqual([200, 409]);
	const created = await attempts.find(response => response.status() === 200)!.json();
	expect((await page.request.delete(`/api/v1/backups/${created.id}`, { headers })).status()).toBe(204);
	expect((await page.request.delete(`/api/v1/backups/${created.id}`, { headers })).status()).toBe(404);
});

test('sorts saved backups and keeps the populated table within the mobile panel', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.route('**/api/v1/backups', async route => {
		await route.fulfill({ json: {
			settings: { enabled: true, intervalDays: 1, retention: 7 }, directory: '/backups', timeZone: 'UTC',
			nextRun: '2026-10-18T03:00:00.000Z', busy: null, error: null,
			backups: [
				{ id: '11111111-1111-4111-8111-111111111111', kind: 'manual', createdAt: '2026-10-15T03:00:00.000Z', applicationVersion: '0.6.2', size: 2048 },
				{ id: '22222222-2222-4222-8222-222222222222', kind: 'upgrade', createdAt: '2026-10-16T03:00:00.000Z', applicationVersion: '0.6.2', size: 4096 },
			],
		} });
	});
	await page.goto('/settings');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	const panel = page.getByRole('tabpanel', { name: /^Backups/ });
	const table = panel.getByRole('table', { name: 'Saved backups' });
	await expect(table.getByRole('row').nth(1)).toContainText('Upgrade recovery');
	await table.getByRole('button', { name: 'Created' }).click();
	await expect(table.getByRole('columnheader', { name: 'Created' })).toHaveAttribute('aria-sort', 'ascending');
	await expect(table.getByRole('row').nth(1)).toContainText('Manual');
	await panel.getByRole('switch', { name: 'Enable automatic backups' }).focus();
	await page.keyboard.press('Space');
	await expect(panel.getByRole('switch')).not.toBeChecked();
	await expect(panel.getByRole('button', { name: 'Save Backup Settings' })).toBeEnabled();
	const typography = await panel.locator('.backup-automatic-header').evaluate(element => {
		const title = element.querySelector('.backup-automatic-copy strong')!;
		const helper = element.querySelector('.backup-automatic-copy small')!;
		const icon = element.querySelector('.backup-automatic-heading > .settings-card-icon')!;
		const peer = element.closest('.backup-settings-panel')!.querySelector('.backup-section-title')!;
		const peerTitle = peer.querySelector('h3')!;
		const peerIcon = peer.querySelector('.settings-card-icon')!;
		const track = element.querySelector('.channel-enabled-track')!;
		const knob = getComputedStyle(track, '::before');
		return {
			titleSize: parseFloat(getComputedStyle(title).fontSize), helperSize: parseFloat(getComputedStyle(helper).fontSize),
			inset: helper.getBoundingClientRect().left - title.getBoundingClientRect().left,
			titleGap: title.getBoundingClientRect().left - icon.getBoundingClientRect().right,
			peerTitleGap: peerTitle.getBoundingClientRect().left - peerIcon.getBoundingClientRect().right,
			trackHeight: track.getBoundingClientRect().height,
			knobHeight: parseFloat(knob.height), padding: parseFloat(getComputedStyle(track).paddingTop),
		};
	});
	expect(typography.helperSize).toBeLessThan(typography.titleSize);
	expect(typography.inset).toBe(0);
	expect(typography.titleGap).toBe(typography.peerTitleGap);
	expect(typography.trackHeight).toBe(typography.knobHeight + 2 * typography.padding);
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		const headingAlignment = await panel.locator('.settings-card-title').evaluateAll(rows => rows.map(row => {
			const heading = row.querySelector('h2, h3')!;
			const range = document.createRange();
			range.selectNodeContents(heading.querySelector('strong') ?? heading);
			const text = range.getBoundingClientRect();
			const help = row.querySelector('.page-help-button')!.getBoundingClientRect();
			return {
				label: heading.textContent,
				centerOffset: help.y + help.height / 2 - text.y - text.height / 2,
				gap: help.x - heading.getBoundingClientRect().right,
			};
		}));
		for (const alignment of headingAlignment) {
			expect(Math.abs(alignment.centerOffset), alignment.label!).toBeLessThanOrEqual(1.5);
			expect(Math.abs(alignment.gap - 8), alignment.label!).toBeLessThanOrEqual(0.5);
		}
		const disclosure = panel.getByRole('button', { name: 'Automatic Backup', exact: true });
		const help = panel.getByRole('button', { name: 'Help with Automatic Backup', exact: true });
		const title = await panel.locator('.backup-automatic-copy strong').boundingBox();
		const helpBounds = await help.boundingBox();
		if (width >= 390) {
			expect(title!.height).toBeLessThan(32);
		}
		expect((await disclosure.boundingBox())!.height).toBeGreaterThanOrEqual(32);
		expect(helpBounds!.x).toBeGreaterThanOrEqual(title!.x + title!.width);
		expect(helpBounds!.x - title!.x - title!.width).toBeLessThanOrEqual(16);
		const handleControl = panel.getByRole('button', { name: 'Toggle automatic backup details', exact: true });
		const handle = await handleControl.boundingBox();
		const header = await panel.locator('.backup-automatic-header').boundingBox();
		const enabled = await panel.locator('.backup-enable').boundingBox();
		expect(handle!.width).toBeGreaterThanOrEqual(44);
		expect(Math.abs(handle!.x + handle!.width - header!.x - header!.width)).toBeLessThanOrEqual(1);
		expect(handle!.height).toBeGreaterThanOrEqual(header!.height - 2);
		expect(enabled!.x + enabled!.width).toBeLessThanOrEqual(handle!.x);
		await disclosure.click();
		await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
		await expect(panel.getByRole('switch')).not.toBeChecked();
		await handleControl.click();
		await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
		const rowLayout = await table.locator('tbody tr').first().evaluate(row => {
			const filename = row.querySelector<HTMLElement>('.backup-name span')!;
			const icon = row.querySelector('svg')!;
			const timestamp = row.querySelector('time')!;
			const range = document.createRange();
			range.selectNodeContents(timestamp);
			return {
				filenameTruncated: filename.scrollWidth > filename.clientWidth,
				fullName: filename.title === filename.textContent,
				iconOffset: Math.abs(icon.getBoundingClientRect().top - filename.getBoundingClientRect().top),
				timestampLines: range.getClientRects().length,
			};
		});
		expect(rowLayout.filenameTruncated).toBe(true);
		expect(rowLayout.fullName).toBe(true);
		expect(rowLayout.iconOffset).toBeLessThanOrEqual(4);
		expect(rowLayout.timestampLines).toBe(1);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await panel.screenshot({ path: 'test-results/backup-settings-populated.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await panel.scrollIntoViewIfNeeded();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	const scroller = panel.locator('.backup-table-scroll');
	await scroller.evaluate(element => {
		element.scrollLeft = element.scrollWidth;
	});
	await expect(table.getByRole('button', { name: /^Delete backup / }).first()).toBeVisible();
	await panel.screenshot({ path: 'test-results/backup-settings-mobile.png' });
});


test('shows an actionable permission error when manual backup storage is denied', async ({ page }) => {
	await authenticateAdministrator(page);
	await page.goto('/settings');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	const panel = page.getByRole('tabpanel', { name: /^Backups/ });
	await expect(panel.getByRole('button', { name: 'Create Backup', exact: true })).toBeEnabled();
	await page.route('**/api/v1/backups', async route => {
		if (route.request().method() === 'POST') {
			await route.fulfill({ status: 503, json: {
				code: 'storage_unavailable', message: 'Permission denied accessing storage. Check the mounted volume’s ownership and permissions for the container user.',
			} });
			return;
		}
		await route.continue();
	});
	await panel.getByRole('button', { name: 'Create Backup', exact: true }).click();
	await expect(panel.getByRole('alert')).toContainText('Permission denied');
	await expect(panel.getByRole('alert')).toContainText('ownership and permissions');
});


test('dismisses persistent backup warnings without hiding a later failure', async ({ page }) => {
	await authenticateAdministrator(page);
	let warning: string | null = 'Upgrade recovery backup or cleanup failed.';
	let dismissed = 0;
	await page.route('**/api/v1/backups/warning', async route => {
		expect(route.request().method()).toBe('DELETE');
		expect(route.request().headers()['x-moirai-csrf']).toBeTruthy();
		warning = null;
		dismissed += 1;
		await route.fulfill({ status: 204 });
	});
	await page.route('**/api/v1/backups', async route => {
		const response = await route.fetch();
		const body = await response.json();
		await route.fulfill({ response, json: { ...body, error: warning } });
	});
	await page.goto('/settings');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	const panel = page.getByRole('tabpanel', { name: /^Backups/ });
	await expect(panel.getByRole('alert')).toContainText('Upgrade recovery');
	await panel.getByRole('button', { name: 'Dismiss backup warning' }).click();
	await expect(panel.getByRole('button', { name: 'Dismiss backup warning' })).toBeHidden();
	expect(dismissed).toBe(1);
	await page.reload();
	await page.getByRole('tab', { name: /^Backups/ }).click();
	await expect(panel.getByRole('button', { name: 'Create Backup', exact: true })).toBeVisible();
	await expect(panel.getByRole('button', { name: 'Dismiss backup warning' })).toBeHidden();
	warning = 'A later backup failed.';
	await page.reload();
	await page.getByRole('tab', { name: /^Backups/ }).click();
	await expect(panel.getByRole('alert')).toContainText(warning);
	await expect(panel.getByRole('button', { name: 'Dismiss backup warning' })).toBeVisible();
});


const reviewBackup = {
	id: '11111111-1111-4111-8111-111111111111', kind: 'automatic', createdAt: '2026-10-18T03:00:00.000Z', applicationVersion: '0.6.2', size: 2048,
};
const readyReview = { id: '22222222-2222-4222-8222-222222222222', backup: reviewBackup, libraries: 4, channels: 6, mediaItems: 16935 };

async function prepareRestorePage(page: Page) {
	await authenticateAdministrator(page);
	await page.route('**/api/v1/backups', async route => {
		const response = await route.fetch();
		await route.fulfill({ response, json: { ...await response.json(), backups: [reviewBackup], error: null } });
	});
	await page.goto('/settings');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	const panel = page.getByRole('tabpanel', { name: /^Backups/ });
	await expect(panel.getByRole('button', { name: 'Restore', exact: true })).toBeEnabled();
	return panel;
}

test('confirms before validation, abandons closed reviews, and protects drafts before final restore', async ({ page }) => {
	const panel = await prepareRestorePage(page);
	let calls = 0;
	let validating = false;
	await page.route('**/api/v1/backups', async route => {
		const response = await route.fetch();
		await route.fulfill({ response, json: { ...await response.json(), backups: [reviewBackup], busy: validating ? 'Validating backup: Checking managed assets (4/4)…' : null } });
	});
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	await page.route('**/api/v1/backups/*/review', async route => {
		calls += 1;
		validating = true;
		await gate;
		validating = false;
		await route.fulfill({ json: readyReview });
	});
	await panel.getByRole('button', { name: 'Restore', exact: true }).click();
	const intent = page.getByRole('alertdialog', { name: 'Restore Backup?' });
	await expect(intent).toBeVisible();
	await intent.getByRole('button', { name: 'Cancel', exact: true }).click();
	expect(calls).toBe(0);
	await panel.getByRole('button', { name: 'Restore', exact: true }).click();
	await intent.getByRole('button', { name: 'Validate Backup' }).click();
	const progress = page.getByRole('dialog', { name: 'Validating Backup', exact: true });
	await expect(progress).toBeVisible();
	await expect(progress).toBeFocused();
	await expect(progress.getByRole('status')).toContainText('Checking managed assets (4/4)');
	await page.keyboard.press('Escape');
	await expect(progress).toBeHidden();
	await expect(panel.getByRole('button', { name: 'Create Backup', exact: true })).toBeDisabled();
	release();
	await expect(panel.getByRole('button', { name: 'Create Backup', exact: true })).toBeEnabled();
	await expect(page.getByRole('alertdialog', { name: 'Replace Configuration?' })).toBeHidden();
	await panel.getByRole('button', { name: 'Automatic Backup', exact: true }).click();
	await panel.getByLabel('Backup interval (days)').fill('3');
	await panel.getByRole('button', { name: 'Restore', exact: true }).click();
	await intent.getByRole('button', { name: 'Validate Backup' }).click();
	const final = page.getByRole('alertdialog', { name: 'Replace Configuration?' });
	await expect(final).toContainText('16935 media items');
	await expect(final).toContainText('Administrator access is preserved');
	await final.getByRole('button', { name: 'Restore and Restart' }).click();
	const discard = page.getByRole('alertdialog', { name: 'Discard Unsaved Settings?' });
	await expect(discard).toBeVisible();
	await discard.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(final.getByRole('button', { name: 'Restore and Restart' })).toBeFocused();
	await final.getByRole('button', { name: 'Cancel Restore' }).click();
	await expect(panel.getByLabel('Backup interval (days)')).toHaveValue('3');
});

test('keeps actionable validation failures and request IDs visible inside the restore dialog', async ({ page }) => {
	const panel = await prepareRestorePage(page);
	await page.route('**/api/v1/backups/*/review', async route => {
		await route.fulfill({ status: 422, json: { code: 'backup_unsupported_schema', message: 'The backup has an unsupported database migration history.', requestId: 'req-restore-17' } });
	});
	await panel.getByRole('button', { name: 'Restore', exact: true }).click();
	await page.getByRole('alertdialog', { name: 'Restore Backup?' }).getByRole('button', { name: 'Validate Backup' }).click();
	const failure = page.getByRole('dialog', { name: 'Backup Validation Failed' });
	await expect(failure.getByRole('alert')).toContainText('unsupported database migration history');
	await expect(failure.getByRole('alert')).toContainText('req-restore-17');
	await expect(failure.getByRole('button', { name: 'Restore and Restart' })).toBeHidden();
	await failure.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(panel.getByRole('button', { name: 'Restore', exact: true })).toBeFocused();
});


test('keeps the review locked once final replacement starts', async ({ page }) => {
	const panel = await prepareRestorePage(page);
	await page.route('**/api/v1/backups/*/review', async route => {
		await route.fulfill({ json: readyReview });
	});
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	await page.route('**/api/v1/backups/reviews/*/restore', async route => {
		await gate;
		await route.fulfill({ status: 202 });
	});
	await panel.getByRole('button', { name: 'Restore', exact: true }).click();
	await page.getByRole('alertdialog', { name: 'Restore Backup?' }).getByRole('button', { name: 'Validate Backup' }).click();
	await page.getByRole('alertdialog', { name: 'Replace Configuration?' }).getByRole('button', { name: 'Restore and Restart' }).click();
	const restoring = page.getByRole('dialog', { name: 'Restoring Configuration' });
	await expect(restoring.getByRole('button', { name: 'Close restore review' })).toBeDisabled();
	await expect(restoring.getByRole('button', { name: 'Cancel Restore' })).toBeDisabled();
	await page.keyboard.press('Escape');
	await expect(restoring).toBeVisible();
	release();
	await expect(restoring.getByText('Restoring configuration and restarting Moirai…')).toBeVisible();
	await expect(restoring.getByRole('button', { name: 'Close restore review' })).toBeDisabled();
});


test('preserves backup policy edits made while a clean status poll is pending', async ({ page }) => {
	await authenticateAdministrator(page);
	let requests = 0;
	let release!: () => void;
	let admitted!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const pending = new Promise<void>(resolve => {
		admitted = resolve;
	});
	await page.route('**/api/v1/backups', async route => {
		requests += 1;
		if (requests === 2) {
			admitted();
			await gate;
		}
		await route.fulfill({ json: {
			settings: { enabled: true, intervalDays: 1, retention: 7 }, backups: [],
			directory: '/backups', timeZone: 'UTC', nextRun: null, busy: null, error: requests >= 2 ? 'Status refreshed' : null,
		} });
	});
	await page.goto('/settings');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	const panel = page.getByRole('tabpanel', { name: /^Backups/ });
	await panel.getByRole('button', { name: 'Automatic Backup', exact: true }).click();
	await pending;
	try {
		await panel.getByLabel('Backup interval (days)').fill('3');
		const response = page.waitForResponse(response => response.url().endsWith('/api/v1/backups'));
		release();
		await response;
		await expect(panel.getByText('Status refreshed', { exact: true })).toBeVisible();
		await expect(panel.getByLabel('Backup interval (days)')).toHaveValue('3');
		await expect(panel.getByRole('button', { name: 'Save Backup Settings' })).toBeEnabled();
	}
	finally {
		release();
	}
});

test('shows damaged archives alongside healthy backups and confirms their deletion', async ({ page }) => {
	await authenticateAdministrator(page);
	const id = '22222222-2222-4222-8222-222222222222';
	let deleted = false;
	await page.route(`**/api/v1/backups/${id}`, async route => {
		expect(route.request().method()).toBe('DELETE');
		deleted = true;
		await route.fulfill({ status: 204 });
	});
	await page.route('**/api/v1/backups', async route => {
		await route.fulfill({ json: {
			settings: { enabled: true, intervalDays: 1, retention: 7 }, directory: '/backups',
			timeZone: 'UTC', nextRun: null, busy: null, error: null,
			backups: [{ id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-10-18T03:00:00.000Z', kind: 'manual', applicationVersion: '0.6.2', size: 2048 }],
			damagedBackups: deleted ? [] : [{ id, name: `${id}.zip` }],
		} });
	});
	await page.goto('/settings');
	await page.getByRole('tab', { name: /^Backups/ }).click();
	const panel = page.getByRole('tabpanel', { name: /^Backups/ });
	const damaged = panel.getByRole('row').filter({ hasText: 'Unreadable backup' });
	await expect(panel.getByRole('link', { name: 'Download' })).toBeVisible();
	await expect(damaged).toContainText('Other backups remain available');
	await damaged.getByRole('button', { name: /^Delete backup / }).click();
	const dialog = page.getByRole('alertdialog', { name: 'Delete Backup?' });
	await expect(dialog).toContainText(`${id}.zip`);
	await dialog.getByRole('button', { name: 'Keep Backup' }).click();
	expect(deleted).toBe(false);
	await damaged.getByRole('button', { name: /^Delete backup / }).click();
	await dialog.getByRole('button', { name: 'Delete Backup', exact: true }).click();
	await expect(damaged).toBeHidden();
	expect(deleted).toBe(true);
	await expect(panel.getByRole('link', { name: 'Download' })).toBeVisible();
});
