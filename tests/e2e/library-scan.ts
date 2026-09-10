import { expect, type Page } from '@playwright/test';
import type { ScanRun } from '@moirai/shared';

/** Wait for the initial scan to finish before asserting catalog contents. */
export async function waitForLibraryScan(page: Page, libraryId: string): Promise<void> {
	await expect.poll(async () => {
		const response = await page.request.get(`/api/v1/libraries/${libraryId}/scans`);
		expect(response.ok()).toBe(true);
		const scans = await response.json() as ScanRun[];
		return scans[0]?.status;
	}, { timeout: 30_000, message: 'Initial library scan should complete successfully' }).toBe('complete');
}
