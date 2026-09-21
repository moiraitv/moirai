import { expect, test } from '@playwright/test';
import { installGuideFixture } from './performance/guide-fixture';

for (const width of [390, 1440]) {
	test(`keeps suppressed issues discoverable with a long scan history at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await installGuideFixture(page, 1);
		const id = '00000000-0000-4000-8000-000000000001';
		const library = {
			id, name: 'Movies', typeKey: 'movies', sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/movies', playbackRoot: null }, enabled: true, watcherEnabled: false,
			watcherStatus: 'stopped', sourceAvailability: 'available', reconciliationStatus: 'idle',
			pendingRemovalCount: 0, itemCount: 0, warningCount: 4,
			lastScanStartedAt: '2026-09-21T10:00:00Z', lastScanCompletedAt: '2026-09-21T10:01:00Z',
		};
		const issues = Array.from({ length: 86 }, (_, index) => ({
			code: 'media_audio_video_duration_mismatch', path: `Movie ${index}.mp4`,
			message: 'Audio/video durations differ. Playback and scheduling use the video duration.', severity: 'warning',
			tailAssessment: { fingerprint: 'a'.repeat(64), result: index < 82 ? 'within-duration-tolerance' : 'uncertain', accepted: false },
		}));
		await page.route('**/api/v1/libraries', route => route.fulfill({ json: [library] }));
		await page.route(`**/api/v1/libraries/${id}`, route => route.fulfill({ json: library }));
		await page.route(`**/api/v1/libraries/${id}/scans`, route => route.fulfill({ json: Array.from({ length: 20 }, (_, index) => ({
			id: `scan-${index}`, status: 'complete', issues, startedAt: library.lastScanStartedAt,
			discoveredCount: 86, changedCount: 0, removedCount: 0,
		})) }));
		await page.route(`**/api/v1/libraries/${id}/reconciliation`, route => route.fulfill({ json: { status: 'idle', pendingRemovalCount: 0 } }));
		await page.route(`**/api/v1/libraries/${id}/media?*`, route => route.fulfill({ json: {
			entries: [], items: [], groups: [], navigation: [],
			pagination: { page: 1, pageSize: 100, totalEntries: 0, totalPages: 0 },
		} }));
		await page.goto(`/libraries/${id}`);
		await page.getByRole('button', { name: 'Last scan: open scan history' }).click();
		const history = page.getByRole('dialog', { name: 'Scan history', exact: true });
		const button = history.getByRole('button', { name: 'Suppressed issues (82)' });
		await expect(button).toBeInViewport();
		await page.screenshot({ path: `test-results/suppressed-history-${width}.png` });
		await button.click();
		const suppressed = page.getByRole('dialog', { name: 'Suppressed issues (82)', exact: true });
		await expect(suppressed).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(suppressed).toHaveCount(0);
		await expect(button).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(history).toHaveCount(0);

		await page.getByRole('button', { name: 'Review Issues', exact: true }).click();
		await page.getByRole('button', { name: 'Show all issues (4)', exact: true }).click();
		const active = page.getByRole('dialog', { name: 'Library scan issues (4)', exact: true });
		const fromIssues = active.getByRole('button', { name: 'Suppressed issues (82)' });
		await expect(fromIssues).toBeInViewport();
		await fromIssues.click();
		await expect(suppressed).toBeVisible();
		await expect(suppressed.locator('li')).toHaveCount(82);
		await page.keyboard.press('Escape');
		await expect(suppressed).toHaveCount(0);
		await expect(active).toBeVisible();
		await expect(fromIssues).toBeFocused();
	});
}
