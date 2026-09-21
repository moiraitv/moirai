import { expect, test } from '@playwright/test';
import { installGuideFixture } from './performance/guide-fixture';

for (const width of [390, 1440]) {
	test(`applies, validates and restores duration filters at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await installGuideFixture(page, 1);
		const id = '00000000-0000-4000-8000-000000000001';
		const library = {
			id, name: 'Movies', typeKey: 'movies', sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/movies', playbackRoot: null }, enabled: true, watcherEnabled: false,
			watcherStatus: 'stopped', sourceAvailability: 'available', reconciliationStatus: 'idle',
			pendingRemovalCount: 0, itemCount: 0, warningCount: 0,
			lastScanStartedAt: '2026-09-21T10:00:00Z', lastScanCompletedAt: '2026-09-21T10:01:00Z',
		};
		await page.route('**/api/v1/libraries', route => route.fulfill({ json: [library] }));
		await page.route(`**/api/v1/libraries/${id}`, route => route.fulfill({ json: library }));
		await page.route(`**/api/v1/libraries/${id}/scans`, route => route.fulfill({ json: [] }));
		await page.route(`**/api/v1/libraries/${id}/reconciliation`, route => route.fulfill({ json: { status: 'idle', pendingRemovalCount: 0 } }));
		await page.route(`**/api/v1/libraries/${id}/media?*`, route => route.fulfill({ json: {
			entries: [], items: [], groups: [], navigation: [],
			pagination: { page: 1, pageSize: 100, totalEntries: 0, totalPages: 0 },
		} }));
		await page.goto(`/libraries/${id}`);
		const trigger = page.getByRole('button', { name: 'Filter media', exact: true });
		await trigger.click();
		const dialog = page.getByRole('dialog', { name: 'Filter media', exact: true });
		const minimum = dialog.getByRole('group', { name: 'Duration', exact: true }).getByRole('group', { name: 'From', exact: true });
		const maximum = dialog.getByRole('group', { name: 'Duration', exact: true }).getByRole('group', { name: 'To', exact: true });
		const apply = dialog.getByRole('button', { name: 'Apply Filters', exact: true });
		await minimum.getByRole('textbox', { name: 'Hours', exact: true }).fill('25');
		await maximum.getByRole('textbox', { name: 'Minutes', exact: true }).fill('60');
		await expect(dialog.getByRole('alert')).toBeVisible();
		await expect(apply).toBeDisabled();
		await maximum.getByRole('textbox', { name: 'Minutes', exact: true }).fill('59');
		await expect(dialog.getByRole('alert')).toContainText('Maximum duration must');
		await maximum.getByRole('textbox', { name: 'Hours', exact: true }).fill('25');
		await maximum.getByRole('textbox', { name: 'Seconds', exact: true }).fill('1');
		await expect(apply).toBeEnabled();
		await expect(minimum).toBeVisible();
		await minimum.scrollIntoViewIfNeeded();
		await page.screenshot({ path: `test-results/duration-filter-${width}.png` });
		const request = page.waitForRequest(request => {
			const url = new URL(request.url());
			return url.pathname.endsWith('/media') && url.searchParams.get('minimumDurationSeconds') === '90000' && url.searchParams.get('maximumDurationSeconds') === '93541';
		});
		await apply.click();
		await request;
		await expect(page).toHaveURL(/minimumDurationSeconds=90000/);
		await page.reload();
		await trigger.click();
		await expect(minimum.getByRole('textbox', { name: 'Hours', exact: true })).toHaveValue('25');
		await expect(maximum.getByRole('textbox', { name: 'Seconds', exact: true })).toHaveValue('1');
		await dialog.getByRole('button', { name: 'Clear All', exact: true }).click();
		await expect(minimum.getByRole('textbox', { name: 'Hours', exact: true })).toHaveValue('');
		await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await trigger.click();
		await expect(minimum.getByRole('textbox', { name: 'Hours', exact: true })).toHaveValue('25');
		await dialog.getByRole('button', { name: 'Clear All', exact: true }).click();
		await minimum.getByRole('textbox', { name: 'Seconds', exact: true }).fill('0');
		await apply.click();
		await expect(page).toHaveURL(/minimumDurationSeconds=0/);
		expect(new URL(page.url()).searchParams.has('maximumDurationSeconds')).toBe(false);
		await trigger.click();
		await dialog.getByRole('button', { name: 'Clear All', exact: true }).click();
		await apply.click();
		await expect.poll(() => new URL(page.url()).searchParams.has('minimumDurationSeconds')).toBe(false);
	});
}
