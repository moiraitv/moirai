import { expect } from '@playwright/test';
import { test } from './fixture';
import { captureSection } from './capture';
import { mediaFixtures, seedLibrary } from './seed';

test('captures Current and Exclusions tabs for Content Programs', { tag: '@docs-screenshot' }, async ({ page, documentationServer }) => {
	const { libraryId } = await seedLibrary(page, documentationServer.directory);
	await page.goto('/schedules/programs/new');
	await page.getByPlaceholder('e.g. Primetime Movies').fill('Evening Cinema Selection');
	await page.getByRole('combobox', { name: 'Library', exact: true }).selectOption(libraryId);
	await page.getByLabel('Limit', { exact: true }).fill('10');
	await page.getByRole('button', { name: 'Manage exclusions', exact: true }).click();
	const drawer = page.getByRole('dialog', { name: 'Manage exclusions', exact: true });
	const rows = drawer.locator('.program-exclusions-list article');
	await expect(drawer.getByRole('tab', { name: 'Current', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(rows).toHaveCount(10);

	// Keep the authored exclusion scene independent of generated item-ID ordering.
	const excluded = mediaFixtures[1];
	await drawer.getByRole('button', { name: `Exclude ${excluded.title}`, exact: true }).click();
	await drawer.getByRole('button', { name: `Confirm exclude ${excluded.title}`, exact: true }).click();
	await expect(rows.filter({ has: page.getByText(excluded.title, { exact: true }) })).toHaveCount(0);
	await expect(rows).toHaveCount(10);
	await expect(drawer.getByRole('tab', { name: 'Exclusions (1)', exact: true })).toBeVisible();
	await page.mouse.move(0, 0);
	await captureSection(page, drawer, 'program-exclusions-current.png');

	await drawer.getByRole('tab', { name: 'Exclusions (1)', exact: true }).click();
	await expect(rows.locator('strong')).toHaveText([excluded.title]);
	await expect(drawer.getByRole('button', { name: `Restore ${excluded.title}`, exact: true })).toBeVisible();
	await page.setViewportSize({ width: 1440, height: 480 });
	await expect(drawer.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
	await page.mouse.move(0, 0);
	await captureSection(page, drawer, 'program-exclusions-list.png');
});
