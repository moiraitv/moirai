import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { authenticateAdministrator } from './authentication';
import { waitForLibraryScan } from './library-scan';

test('excludes a show, season and episode, backfills a limited query, and retains the saved draft baseline', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const headers = { 'x-moirai-csrf': await authenticateAdministrator(page) };
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-exclusions-'));
	let libraryId: string | undefined;
	let programId: string | undefined;
	try {
		for (const [show, season, title, episode] of [
			['Aster', 1, 'Aster Pilot', 1], ['Birch', 1, 'Birch Pilot', 1],
			['Birch', 2, 'Birch Return', 1], ['Birch', 2, 'Birch Finale', 2], ['Cedar', 1, 'Cedar Pilot', 1],
		] as const) {
			const directory = path.join(root, show, `Season ${season}`);
			const filename = `${show} S0${season}E0${episode}`;
			await mkdir(directory, { recursive: true });
			await writeFile(path.join(directory, `${filename}.mp4`), 'fixture');
			await writeFile(path.join(directory, `${filename}.nfo`), `<episodedetails><title>${title}</title><season>${season}</season><episode>${episode}</episode></episodedetails>`);
		}
		const createdLibrary = await page.request.post('/api/v1/libraries', { headers, data: {
			name: 'Exclusion library', typeKey: 'shows', sourceType: 'on-disk', sourceConfig: { scanRoot: root }, watcherEnabled: false,
		} });
		expect(createdLibrary.ok()).toBe(true);
		libraryId = (await createdLibrary.json()).id;
		await waitForLibraryScan(page, libraryId!);
		await page.goto('/schedules/programs/new');
		await page.getByPlaceholder('e.g. Primetime Movies').fill('Selected episodes');
		await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(libraryId!);
		await page.getByLabel('Limit', { exact: true }).fill('2');
		const opener = page.getByRole('button', { name: 'Manage exclusions' });
		await opener.click();
		const drawer = page.getByRole('dialog', { name: 'Manage exclusions' });
		await expect(drawer).toBeFocused();
		const excludeShow = drawer.getByRole('button', { name: 'Exclude Aster', exact: true });
		const confirmShow = drawer.getByRole('button', { name: 'Confirm exclude Aster', exact: true });
		await excludeShow.click();
		await expect(confirmShow).toBeFocused();
		await expect(drawer.getByRole('tab', { name: 'Excluded (0)' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(excludeShow).toBeFocused();
		await excludeShow.click();
		await confirmShow.click();
		await drawer.getByRole('searchbox', { name: 'Search library media' }).fill('Birch');
		await drawer.getByRole('combobox', { name: 'Search for' }).selectOption('groups');
		await drawer.getByRole('button', { name: 'Browse Birch', exact: true }).click();
		await drawer.getByRole('button', { name: 'Exclude Season 1', exact: true }).click();
		await drawer.getByRole('button', { name: 'Confirm exclude Season 1', exact: true }).click();
		await drawer.getByRole('button', { name: 'Browse Season 2', exact: true }).click();
		await drawer.getByRole('button', { name: 'Exclude Birch Return', exact: true }).click();
		await drawer.getByRole('button', { name: 'Confirm exclude Birch Return', exact: true }).click();
		await expect(drawer.getByRole('tab', { name: 'Excluded (3)' })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath('exclusions-desktop.png'), animations: 'disabled' });
		await drawer.getByRole('button', { name: 'Done', exact: true }).click();
		await expect(opener).toBeFocused();
		await expect(page.locator('.quick-query-carousel-item')).toHaveCount(2);
		await expect(page.locator('.quick-query-carousel-item').filter({ hasText: 'Cedar Pilot' })).toHaveCount(1);
		await expect(page.locator('.quick-query-carousel-item').filter({ hasText: 'Birch Finale' })).toHaveCount(1);
		const saved = page.waitForResponse(response => response.url().endsWith('/api/v1/programs') && response.request().method() === 'POST');
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		const savedResponse = await saved;
		expect(savedResponse.ok()).toBe(true);
		const program = await savedResponse.json();
		programId = program.id;
		expect(program.config.source.exclusions.groupIds).toHaveLength(2);
		expect(program.config.source.exclusions.itemIds).toHaveLength(1);
		await page.goto(`/schedules/programs/${programId}`);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		for (const width of [390, 320]) {
			await page.setViewportSize({ width, height: 844 });
			await opener.click();
			await expect(drawer).toBeFocused();
			await drawer.getByRole('tab', { name: 'Browse library' }).focus();
			await page.keyboard.press('ArrowRight');
			await expect(drawer.getByRole('tab', { name: 'Excluded (3)' })).toBeFocused();
			await expect(drawer.getByRole('button', { name: 'Restore Birch Return' })).toBeVisible();
			expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			await page.screenshot({ path: testInfo.outputPath(`exclusions-${width}.png`), animations: 'disabled' });
			if (width === 390) {
				await page.keyboard.press('Escape');
				await expect(opener).toBeFocused();
			}
		}
		await drawer.getByRole('button', { name: 'Restore Birch Return' }).click();
		await page.keyboard.press('Escape');
		await expect(drawer.getByRole('button', { name: 'Restore Birch Return' })).toBeFocused();
		await drawer.getByRole('button', { name: 'Restore Birch Return' }).click();
		await drawer.getByRole('button', { name: 'Confirm restore Birch Return' }).click();
		await drawer.getByRole('button', { name: 'Done', exact: true }).click();
		await page.reload();
		await expect(page.locator('.program-exclusions-summary')).toContainText('2 entries');
		await page.getByRole('button', { name: 'Reset', exact: true }).click();
		await page.getByRole('button', { name: 'Confirm Reset', exact: true }).click();
		await expect(page.locator('.program-exclusions-summary')).toContainText('3 entries');
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
