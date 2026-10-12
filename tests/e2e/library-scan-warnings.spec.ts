import { expect, test } from '@playwright/test';
import { installGuideFixture } from './performance/guide-fixture';

for (const count of [1, 10, 25]) {
	test(`limits ${count} library warnings inline and exposes full details on demand`, async ({ page }) => {
		await installGuideFixture(page, 1);
		const id = '00000000-0000-4000-8000-000000000001';
		const library = {
			id, name: 'Movies', typeKey: 'movies', sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/movies', playbackRoot: null }, enabled: true, watcherEnabled: false,
			watcherStatus: 'stopped', sourceAvailability: 'available', reconciliationStatus: 'idle',
			pendingRemovalCount: 0, itemCount: 0, warningCount: count,
			lastScanStartedAt: '2026-09-21T10:00:00Z', lastScanCompletedAt: '2026-09-21T10:01:00Z',
		};
		const issues = Array.from({ length: count }, (_, index) => ({
			code: 'media_audio_video_duration_mismatch', path: `Movie ${index + 1}.mp4`,
			message: `Audio/video duration mismatch for movie ${index + 1}.`, severity: 'warning',
		}));
		await page.route('**/api/v1/libraries', route => route.fulfill({ json: [library] }));
		await page.route(`**/api/v1/libraries/${id}`, route => route.fulfill({ json: library }));
		await page.route(`**/api/v1/libraries/${id}/scans`, route => route.fulfill({ json: [{
			id: 'scan', status: 'partial', issues, startedAt: library.lastScanStartedAt,
			discoveredCount: count, changedCount: 0, removedCount: 0,
		}] }));
		await page.route(`**/api/v1/libraries/${id}/reconciliation`, route => route.fulfill({ json: { status: 'idle', pendingRemovalCount: 0 } }));
		await page.route(`**/api/v1/libraries/${id}/media?*`, route => route.fulfill({ json: {
			entries: [], items: [], groups: [], navigation: [],
			pagination: { page: 1, pageSize: 100, totalEntries: 0, totalPages: 0 },
		} }));
		await page.goto(`/libraries/${id}`);
		const banner = page.locator('.library-warning-banner');
		await banner.getByRole('button', { name: 'Review Issues' }).click();
		await expect(banner.locator('li')).toHaveCount(Math.min(10, count));
		const showAll = banner.getByRole('button', { name: /Show all issues/ });


		for (const dismissal of ['escape', 'close', 'backdrop']) {
			await showAll.click();
			const dialog = page.getByRole('dialog', { name: /Library scan issues/ });
			await expect(dialog.locator('li')).toHaveCount(count);
			await dialog.getByText(`Movie ${count}.mp4`, { exact: true }).scrollIntoViewIfNeeded();
			await expect(dialog.getByText(`Movie ${count}.mp4`, { exact: true })).toBeVisible();
			if (dismissal === 'escape') {
				await page.keyboard.press('Escape');
			}
			else if (dismissal === 'close') {
				await dialog.getByRole('button', { name: 'Close scan issues' }).click();
			}
			else {
				await page.locator('.moirai-dialog-backdrop').click({ position: { x: 2, y: 2 } });
			}
			await expect(dialog).toHaveCount(0);
			await expect(showAll).toBeFocused();
		}
		await expect(banner.locator('li')).toHaveCount(Math.min(10, count));
	});
}

for (const active of [false, true]) {
	test(`hides informational diagnostics from ${active ? 'mixed' : 'healthy'} library issue views`, async ({ page }) => {
		await installGuideFixture(page, 1);
		const id = '00000000-0000-4000-8000-000000000001';
		const library = {
			id, name: 'Movies', typeKey: 'movies', sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/movies', playbackRoot: null }, enabled: true, watcherEnabled: false,
			watcherStatus: 'stopped', sourceAvailability: 'available', reconciliationStatus: 'idle',
			pendingRemovalCount: 0, itemCount: 0, warningCount: active ? 1 : 0,
			lastScanStartedAt: '2026-09-21T10:00:00Z', lastScanCompletedAt: '2026-09-21T10:01:00Z',
		};
		const issues = [
			{ code: 'metadata_invalid', path: 'quiet.nfo', message: 'Unused episode fields', severity: 'warning', informational: true },
			{ code: 'nfo_missing', path: 'quiet.mp4', message: 'Usable fallback', severity: 'warning', informational: true,
				ignoreState: { fingerprint: 'a'.repeat(64), ignored: true } },
			...(active ? [
				{ code: 'metadata_invalid', path: 'actionable.nfo', message: 'Invalid rating', severity: 'warning' },
				{ code: 'nfo_invalid', path: 'suppressed.nfo', message: 'Ignored malformed sidecar', severity: 'warning',
					ignoreState: { fingerprint: 'b'.repeat(64), ignored: true } },
			] : []),
		];
		await page.route('**/api/v1/libraries', route => route.fulfill({ json: [library] }));
		await page.route(`**/api/v1/libraries/${id}`, route => route.fulfill({ json: library }));
		await page.route(`**/api/v1/libraries/${id}/scans`, route => route.fulfill({ json: [{
			id: 'scan', status: 'complete', issues, startedAt: library.lastScanStartedAt,
			discoveredCount: 1, changedCount: 0, removedCount: 0,
		}] }));
		await page.route(`**/api/v1/libraries/${id}/reconciliation`, route => route.fulfill({ json: { status: 'idle', pendingRemovalCount: 0 } }));
		await page.route(`**/api/v1/libraries/${id}/media?*`, route => route.fulfill({ json: {
			entries: [], items: [], groups: [], navigation: [],
			pagination: { page: 1, pageSize: 100, totalEntries: 0, totalPages: 0 },
		} }));
		await page.goto(`/libraries/${id}`);
		const banner = page.locator('.library-warning-banner');
		if (active) {
			await banner.getByRole('button', { name: 'Review Issues' }).click();
			await expect(banner.locator('li')).toHaveCount(1);
			await expect(banner).not.toContainText('quiet');
			await banner.getByRole('button', { name: /Show all issues/ }).click();
			const dialog = page.getByRole('dialog', { name: /Library scan issues/ });
			await expect(dialog.locator('li')).toHaveCount(1);
			await expect(dialog).not.toContainText('quiet');
			await dialog.getByRole('button', { name: 'Suppressed issues (1)' }).click();
			const suppressed = page.getByRole('dialog', { name: 'Suppressed issues (1)' });
			await expect(suppressed.locator('li')).toHaveCount(1);
			await expect(suppressed).not.toContainText('quiet');
			await suppressed.getByRole('button', { name: 'Close scan issues' }).click();
			await dialog.getByRole('button', { name: 'Close scan issues' }).click();
		}
		else {
			await expect(banner).toHaveCount(0);
		}
		await page.getByRole('button', { name: 'Last scan: open scan history' }).click();
		const history = page.getByRole('dialog', { name: 'Scan history' });
		await expect(history.locator('li')).toHaveCount(active ? 2 : 0);
		await expect(history).not.toContainText('quiet');
		await expect(history.getByRole('button', { name: /Suppressed issues/ })).toHaveCount(active ? 1 : 0);
	});
}
