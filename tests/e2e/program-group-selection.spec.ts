import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { authenticateAdministrator } from './authentication';
import { waitForLibraryScan } from './library-scan';

test('selects seasons into a sequential program and appends without duplicates', async ({ page }) => {
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-season-selection-'));
	let libraryId: string | undefined;
	let programId: string | undefined;
	try {
		for (let season = 1; season <= 12; season++) {
			const directory = path.join(root, 'Example Show', `Season ${String(season).padStart(2, '0')}`);
			await mkdir(directory, { recursive: true });
			await writeFile(path.join(directory, `Example Show S${String(season).padStart(2, '0')}E01.mp4`), 'fixture');
		}
		const response = await page.request.post('/api/v1/libraries', {
			headers, data: { name: 'Season selection', typeKey: 'shows', sourceType: 'on-disk', sourceConfig: { scanRoot: root }, watcherEnabled: false },
		});
		expect(response.ok()).toBe(true);
		libraryId = (await response.json()).id;
		await waitForLibraryScan(page, libraryId!);
		await page.goto(`/libraries/${libraryId}`);
		await page.getByRole('button', { name: 'Add Example Show to a program', exact: true }).click();
		await expect(page.getByRole('dialog', { name: 'Add to program' })).toBeVisible();
		await page.getByRole('dialog', { name: 'Add to program' }).getByRole('button', { name: 'Cancel', exact: true }).click();
		await page.locator('.media-card').filter({ hasText: 'Example Show' }).click();
		await page.getByRole('button', { name: 'Select groups', exact: true }).click();
		await page.getByRole('button', { name: 'Add All Items', exact: true }).click();
		await expect(page.getByRole('dialog')).toContainText('All matching items');
		await expect(page.getByRole('dialog')).toContainText('selected-items program');
		await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();

		for (let season = 1; season <= 8; season++) {
			await page.getByRole('button', { name: `Select Season ${season}`, exact: true }).click();
		}
		await page.getByRole('button', { name: 'Add Selected', exact: true }).click();
		await page.getByLabel('Program name', { exact: true }).fill('First eight seasons');
		await expect(page.getByLabel('Playback order')).toHaveValue('sequential');
		const saved = page.waitForResponse(response => response.url().endsWith('/program-groups') && response.request().method() === 'POST');
		await page.getByRole('button', { name: 'Add to Program', exact: true }).click();
		const result = await (await saved).json();
		programId = result.program.id;
		expect(result.program.config.source.type).toBe('group-collection');
		expect(result.program.config.source.groupIds).toHaveLength(8);
		expect(result.program.config.strategy.type).toBe('sequential');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.getByRole('button', { name: 'Select groups', exact: true }).click();
		await page.getByRole('button', { name: 'Select Season 8', exact: true }).click();
		await page.getByRole('button', { name: 'Select Season 9', exact: true }).click();
		await page.getByRole('button', { name: 'Add Selected', exact: true }).click();
		await expect(page.getByRole('radio').first()).toBeChecked();
		const appended = page.waitForResponse(response => response.url().endsWith('/program-groups') && response.request().method() === 'POST');
		await page.getByRole('button', { name: 'Add to Program', exact: true }).click();
		expect(await (await appended).json()).toMatchObject({ created: false, addedGroupCount: 1, alreadySelectedCount: 1 });
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.screenshot({ path: 'test-results/group-selection.png' });
	}
	finally {
		if (programId) {
			await page.request.delete(`/api/v1/programs/${programId}`, { headers });
		}
		if (libraryId) {
			await page.request.delete(`/api/v1/libraries/${libraryId}`, { headers });
		}
		await rm(root, { recursive: true, force: true });
	}
});
