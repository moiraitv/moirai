import { expect, test } from '@playwright/test';
import { installGuideFixture } from './performance/guide-fixture';

for (const width of [390, 1440]) {
	test(`accepts and restores silent endings at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await installGuideFixture(page, 1);
		const id = '00000000-0000-4000-8000-000000000001';
		const library = {
			id, name: 'Movies', typeKey: 'movies', sourceType: 'on-disk',
			sourceConfig: { scanRoot: '/movies', playbackRoot: null }, enabled: true, watcherEnabled: false,
			watcherStatus: 'stopped', sourceAvailability: 'available', reconciliationStatus: 'idle',
			pendingRemovalCount: 0, itemCount: 0, warningCount: 1,
			lastScanStartedAt: '2026-09-21T10:00:00Z', lastScanCompletedAt: '2026-09-21T10:01:00Z',
		};
		const issues = ['not-black', 'mostly-black'].map((result, index) => ({
			code: 'media_audio_video_duration_mismatch', path: `Movie ${index + 1}.mp4`,
			message: 'Audio tracks end together before the video.', severity: 'warning',
			tailAssessment: { fingerprint: 'a'.repeat(64), result, accepted: false },
		}));
		const scans = [{ id: 'scan', status: 'complete', issues, startedAt: library.lastScanStartedAt,
			discoveredCount: 2, changedCount: 0, removedCount: 0 }];
		let conflict = false;
		let candidateCode: string | undefined;
		let acceptanceRequests = 0;
		await page.route('**/api/v1/libraries', route => route.fulfill({ json: [library] }));
		await page.route(`**/api/v1/libraries/${id}`, route => route.fulfill({ json: library }));
		await page.route(`**/api/v1/libraries/${id}/scans`, route => route.fulfill({ json: candidateCode
			? [{ ...scans[0], status: 'partial', issues: [...issues, {
				code: candidateCode, path: null, message: 'Review the candidate source.', severity: 'error',
			}] }] : scans }));
		await page.route(`**/api/v1/libraries/${id}/reconciliation`, route => route.fulfill({ json: { status: 'idle', pendingRemovalCount: 0 } }));
		await page.route(`**/api/v1/libraries/${id}/media?*`, route => route.fulfill({ json: {
			entries: [], items: [], groups: [], navigation: [],
			pagination: { page: 1, pageSize: 100, totalEntries: 0, totalPages: 0 },
		} }));
		await page.route(`**/api/v1/libraries/${id}/silent-ending`, async route => {
			acceptanceRequests += 1;
			if (conflict) {
				await route.fulfill({ status: 409, json: { message: 'A scan is running.' } });
				return;
			}
			const input = route.request().postDataJSON();
			expect(input.path).toBe(issues[0]!.path);
			expect(input.fingerprint).toBe(issues[0]!.tailAssessment.fingerprint);
			issues[0]!.tailAssessment.accepted = input.accepted;
			library.warningCount = input.accepted ? 0 : 1;
			await route.fulfill({ json: scans });
		});
		// Each candidate scan path must block decisions until an accepted-source scan replaces it.
		for (const code of ['source_change_requires_approval', 'source_identity_requires_approval', 'source_candidate_incomplete']) {
			candidateCode = code;
			library.warningCount = 2;
			await page.goto(`/libraries/${id}`);
			await page.getByRole('button', { name: 'Review Issues' }).click();
			await page.getByRole('button', { name: 'Show all issues (2)' }).click();
			const candidateDialog = page.getByRole('dialog', { name: /Library scan issues/ });
			await expect(candidateDialog.getByRole('button', { name: 'Accept silent ending' })).toBeDisabled();
			await expect(candidateDialog.getByText(/Review and approve the source change/)).toBeVisible();
			await candidateDialog.getByRole('button', { name: 'Close scan issues' }).click();
			await page.getByRole('button', { name: 'Hide Issues' }).click();
		}
		expect(acceptanceRequests).toBe(0);
		candidateCode = undefined;
		library.warningCount = 1;
		await page.goto(`/libraries/${id}`);
		await expect(page.getByRole('button', { name: 'Suppressed issues (1)' })).toBeVisible();
		await page.getByRole('button', { name: 'Review Issues' }).click();
		await page.getByRole('button', { name: 'Show all issues (1)' }).click();
		let dialog = page.getByRole('dialog', { name: /Library scan issues/ });
		conflict = true;
		await dialog.getByRole('button', { name: 'Accept silent ending' }).click();
		await expect(dialog.getByRole('alert')).toContainText('A scan is running.');
		conflict = false;
		await dialog.getByRole('button', { name: 'Accept silent ending' }).click();
		await expect(dialog.getByText('No issues remain in this list.')).toBeVisible();
		await dialog.getByRole('button', { name: 'Close scan issues' }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('.library-warning-banner')).toHaveCount(0);
		await page.getByRole('button', { name: 'Suppressed issues (2)' }).click();
		dialog = page.getByRole('dialog', { name: /Suppressed issues/ });
		await expect(dialog.getByText('Automatically suppressed: the complete inspected silent ending is at least 90% black in every frame.')).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Restore warning' })).toHaveCount(1);
		await page.screenshot({ animations: 'disabled', path: `test-results/silent-endings-${width}.png` });
		await dialog.getByRole('button', { name: 'Restore warning' }).click();
		await expect(dialog.locator('li')).toHaveCount(1);
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('.library-warning-banner')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Suppressed issues (1)' })).toBeFocused();
	});
}
